import * as vscode from 'vscode'
import type { ClaudeTerminalProvider } from './treeProvider.js'
import { buildViewModel, resolveShortcut } from './viewModel.js'
import type { HistoryEntry, TicketRecord, ViewModel } from './viewModel.js'
import { readSessionHistory } from './sessionHistory.js'
import { readSessionContextTokens } from './contextSize.js'
import { runTicketCommand } from './ticketProvider.js'
import { TerminalTitles } from './terminalTitle.js'
import { createRepoRootCache } from './repoRoot.js'
import {
  getHistoryHours,
  getPanelDensity,
  getTicketsCommand,
  getTicketsRefreshSeconds,
  getEnableTerminalShortcuts,
  getTerminalTitleMaxLength,
} from './settings.js'
import type {
  FromWebview,
  PanelView,
  StateMessage,
  WindowMessage,
} from './webview/protocol.js'

const VIEW_KEY = 'panel:view'
const HISTORY_REFRESH_MS = 60_000
/** A live session's context grows turn by turn, so it is re-read often. */
const CONTEXT_REFRESH_MS = 5_000

/** Coalesce the bursts of session events a single turn produces. */
const PUSH_DEBOUNCE_MS = 60

const nonce = (): string => {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return out
}

export class PanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeTerminalManagerPanel'

  private _view: vscode.WebviewView | undefined
  private _history: readonly HistoryEntry[] = []
  private _context = new Map<string, number>()
  private _tickets: readonly TicketRecord[] | undefined
  private _lastModel: ViewModel | undefined
  private _lastLiveIds = new Set<string>()
  private _pushTimer: ReturnType<typeof setTimeout> | undefined
  private _timers: Array<ReturnType<typeof setInterval>> = []
  private _disposed = false
  private readonly _repoRoot = createRepoRootCache()
  private _windowFocused = vscode.window.state.focused
  private _ticketsAt = 0
  private _ticketsRunning = false
  private readonly _titles: TerminalTitles
  private readonly _disposables: vscode.Disposable[] = []

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _provider: ClaudeTerminalProvider,
    private readonly _state: vscode.Memento,
    private readonly _log: (message: string) => void = () => {},
    titles?: TerminalTitles,
  ) {
    this._titles = titles ?? new TerminalTitles(_log)
    this._disposables.push(
      this._provider.onDidChangeSessions(() => {
        this.schedulePush()
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused === this._windowFocused) return
        this._windowFocused = state.focused
        this.postWindowState()
        // Catch up on what the timers skipped while the window was in the background.
        if (this.isWatched) {
          void this.refreshHistory()
          this.refreshContext()
          // The tickets command can take seconds; alt-tabbing must not re-run it.
          const due = Math.max(15, getTicketsRefreshSeconds()) * 1000
          if (Date.now() - this._ticketsAt >= due) void this.refreshTickets()
        }
      }),
    )
  }

  /**
   * Whether anyone can be looking at the panel. With several windows open, the
   * background ones would otherwise each keep re-reading transcripts and
   * shelling out to the tickets command for a view nobody sees.
   */
  private get isWatched(): boolean {
    return this._view?.visible === true && this._windowFocused
  }

  private postWindowState(): void {
    const message: WindowMessage = { type: 'window', focused: this._windowFocused }
    void this._view?.webview.postMessage(message)
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    }
    view.webview.html = this._html(view.webview)

    this._disposables.push(
      view.webview.onDidReceiveMessage((message: FromWebview) => {
        void this._onMessage(message)
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          void this.refreshHistory()
          this.schedulePush()
        }
      }),
    )

    view.onDidDispose(() => {
      this._view = undefined
    })

    void this.refreshHistory()
    void this.refreshTickets()
    this.refreshContext()
    this.startTimers()
  }

  private startTimers(): void {
    if (this._timers.length > 0) return
    this._timers.push(
      setInterval(() => {
        if (this.isWatched) void this.refreshHistory()
      }, HISTORY_REFRESH_MS),
    )
    this._timers.push(
      setInterval(() => {
        if (this.isWatched) this.refreshContext()
      }, CONTEXT_REFRESH_MS),
    )
    this._timers.push(
      setInterval(
        () => {
          if (this.isWatched) void this.refreshTickets()
        },
        Math.max(15, getTicketsRefreshSeconds()) * 1000,
      ),
    )
  }

  /** Re-index finished sessions. Filesystem work, so never on the push path. */
  async refreshHistory(): Promise<void> {
    const hours = getHistoryHours()
    if (hours <= 0) {
      if (this._history.length > 0) {
        this._history = []
        this.schedulePush()
      }
      return
    }
    this._history = await readSessionHistory({
      hours,
      now: Date.now(),
      knownCwds: this._provider.getKnownCwds(),
    })
    this.refreshContext()
    this.schedulePush()
  }

  /** Re-run the configured tickets command. Shells out, so also off the path. */
  async refreshTickets(): Promise<void> {
    const command = getTicketsCommand()
    if (command.trim().length === 0) {
      if (this._tickets !== undefined) {
        this._tickets = undefined
        this.schedulePush()
      }
      return
    }
    // On a loaded machine one run can outlast the refresh interval; stacking
    // another shell on top only makes the next one slower still.
    if (this._ticketsRunning) return
    this._ticketsRunning = true
    this._ticketsAt = Date.now()
    let tickets: readonly TicketRecord[] | undefined
    try {
      tickets = await runTicketCommand({
        command,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        log: this._log,
      })
    } finally {
      this._ticketsRunning = false
    }
    // A failed run is a slow shell or a flaky API far more often than a command
    // that stopped existing. Dropping the tab on one bad run makes the tickets
    // vanish for a minute at a time; the stale list is the better answer.
    if (tickets === undefined && this._tickets !== undefined) return
    this._tickets = tickets
    this.schedulePush()
  }

  /**
   * Re-read every visible session's context size.
   *
   * Reads are mtime-cached, so a pass over unchanged transcripts costs a stat
   * each. Only a changed number pushes, otherwise the panel would rebuild
   * itself every five seconds for nothing.
   */
  refreshContext(): void {
    const next = new Map<string, number>()
    const take = (id: string, cwd: string | undefined): void => {
      if (cwd === undefined || next.has(id)) return
      const tokens = readSessionContextTokens(cwd, id)
      if (tokens !== undefined) next.set(id, tokens)
    }

    for (const session of this._provider.getSessions()) {
      take(session.sessionId, session.cwd)
    }
    for (const remote of this._provider.getRemoteSessionInputs()) {
      take(remote.sessionId, remote.cwd)
    }
    for (const entry of this._history) take(entry.id, entry.cwd)

    let changed = next.size !== this._context.size
    if (!changed) {
      for (const [id, tokens] of next) {
        if (this._context.get(id) !== tokens) {
          changed = true
          break
        }
      }
    }
    this._context = next
    if (changed) this.schedulePush()
  }

  private get view(): PanelView {
    const stored = this._state.get<string>(VIEW_KEY, 'active')
    // 'projects' is the pre-split name for what is now the Active tab.
    const view: PanelView =
      stored === 'recent' || stored === 'tickets'
        ? stored
        : 'active'
    // Never strand the user on a tab that is no longer offered.
    return view === 'tickets' && this._tickets === undefined ? 'active' : view
  }

  schedulePush(): void {
    // An in-flight refresh can land after the view is gone; a disposed panel
    // must not wake back up to push into it.
    if (this._disposed) return
    if (this._pushTimer !== undefined) clearTimeout(this._pushTimer)
    this._pushTimer = setTimeout(() => {
      this._pushTimer = undefined
      this.push()
    }, PUSH_DEBOUNCE_MS)
  }

  push(): void {
    // The model is built even with no view: ctrl+alt+N is a global keybinding
    // and must resolve whether or not the panel is currently showing.
    const shortcutsEnabled = getEnableTerminalShortcuts()
    const model = buildViewModel({
      sessions: this._provider.getSessions(),
      remote: this._provider.getRemoteSessionInputs(),
      history: this._history,
      tickets: this._tickets,
      workspaceName: this._provider.getWorkspaceName() ?? vscode.workspace.name,
      workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      workspaceBranch: this._provider.getBranch(),
      activeTerminalId:
        vscode.window.activeTerminal === undefined
          ? undefined
          : this._provider.getTerminalPid(vscode.window.activeTerminal),
      terminals: this._provider.getPlainTerminals(),
      storedName: (id) => this._state.get<string>(`session:name:${id}`),
      repoRoot: this._repoRoot,
      contextTokens: (id) => this._context.get(id),
      shortcutsEnabled,
    })
    this._lastModel = model
    // Tabs show in background windows too, so titles follow every push.
    this._titles.sync(
      model,
      (id) => {
        const terminal = this._provider.getTerminalForSession(id)
        const pid =
          terminal === undefined ? undefined : this._provider.getTerminalPid(terminal)
        return terminal === undefined || pid === undefined
          ? undefined
          : { pid, fallback: terminal.name }
      },
      getTerminalTitleMaxLength(),
    )

    // A session that just stopped being live has become resumable, and its
    // transcript is already on disk — re-index now rather than leaving a gap
    // until the next timer tick.
    const liveIds = new Set<string>()
    for (const group of model.active) {
      for (const session of group.live) liveIds.add(session.id)
    }
    let disappeared = false
    for (const id of this._lastLiveIds) {
      if (!liveIds.has(id)) {
        disappeared = true
        break
      }
    }
    this._lastLiveIds = liveIds
    if (disappeared) void this.refreshHistory()

    const view = this._view
    if (view === undefined) return

    // The activity-bar badge is the only signal visible with the panel closed.
    view.badge =
      model.attentionCount > 0
        ? {
            value: model.attentionCount,
            tooltip:
              model.attentionCount === 1
                ? '1 session is waiting for you'
                : `${model.attentionCount} sessions are waiting for you`,
          }
        : undefined

    // A hidden webview renders nothing; showing it again schedules a push.
    if (!view.visible) return

    const message: StateMessage = {
      type: 'state',
      model,
      view: this.view,
      density: getPanelDensity(),
      shortcutsEnabled,
    }
    void view.webview.postMessage(message)
  }

  /**
   * What ctrl+alt+N points at, resolved against the model the panel last
   * rendered rather than a separate tree walk.
   */
  resolveShortcut(
    index: number,
  ): { kind: 'session'; id: string } | { kind: 'terminal'; pid: number } | undefined {
    return this._lastModel === undefined
      ? undefined
      : resolveShortcut(this._lastModel, index)
  }

  private async _onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postWindowState()
        this.push()
        return
      case 'setView':
        await this._state.update(VIEW_KEY, message.view)
        this.push()
        return
      case 'focus':
        await vscode.commands.executeCommand(
          'claudeTerminalManager.focusSession',
          message.id,
        )
        return
      case 'resume':
        await vscode.commands.executeCommand(
          'claudeTerminalManager.resumeSession',
          message.id,
        )
        return
      case 'close':
        await vscode.commands.executeCommand(
          'claudeTerminalManager.closeSession',
          message.id,
        )
        return
      case 'focusTerminal':
        this._withTerminal(message.pid, (t) => t.show(false))
        return
      case 'closeTerminal':
        this._withTerminal(message.pid, (t) => t.dispose())
        return
      case 'rename':
        await vscode.commands.executeCommand(
          'claudeTerminalManager.renameSessionById',
          message.id,
        )
        return
      case 'newSession':
        await vscode.commands.executeCommand(
          'claudeTerminalManager.newSession',
          message.project,
          message.folder,
        )
        return
      case 'openTicket':
        await vscode.env.openExternal(vscode.Uri.parse(message.url))
        return
      case 'refreshTickets':
        await this.refreshTickets()
        return
    }
  }

  private _withTerminal(
    pid: number,
    action: (terminal: vscode.Terminal) => void,
  ): void {
    for (const terminal of vscode.window.terminals) {
      if (this._provider.getTerminalPid(terminal) === pid) {
        action(terminal)
        return
      }
    }
  }

  private _html(webview: vscode.Webview): string {
    const n = nonce()
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'webview.js'),
    )
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.css'),
    )
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style.toString()}" rel="stylesheet">
<title>Terminals</title>
</head>
<body>
<div class="seg" id="seg" role="tablist" aria-label="View">
  <button role="tab" id="seg-active" aria-selected="true">Active</button>
  <button role="tab" id="seg-recent" aria-selected="false">Recent</button>
  <button role="tab" id="seg-tickets" aria-selected="false" hidden>Tickets</button>
</div>
<div id="body"></div>
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`
  }

  dispose(): void {
    this._disposed = true
    for (const timer of this._timers) clearInterval(timer)
    this._timers = []
    if (this._pushTimer !== undefined) clearTimeout(this._pushTimer)
    for (const d of this._disposables) d.dispose()
  }
}
