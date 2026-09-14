import * as vscode from 'vscode'
import type { SessionRecord } from './stateMachine.js'
import { getShowNonClaudeTerminals, getShowTerminalsFromAllWindows } from './settings.js'
import type { WindowEntry, RemoteTerminalInfo } from './windowRegistry.js'
import type { RemoteSessionInput, TerminalInput } from './viewModel.js'

const LIVENESS_TTL_MS = 1000

export type TerminalNode = {
  readonly kind: 'terminal'
  readonly terminal: vscode.Terminal
  readonly pid: number | undefined
}

export type SessionNode = {
  readonly kind: 'session'
  readonly record: SessionRecord
  readonly terminal: vscode.Terminal | undefined
}

export type RemoteTerminalNode = {
  readonly kind: 'remoteTerminal'
  readonly windowId: string
  readonly workspaceName: string
  readonly workspaceFolderPath?: string
  readonly terminalName: string
  readonly socketPath: string
  readonly pid?: number
  readonly session?: {
    readonly sessionId: string
    readonly status: string
    readonly subtitle: string | undefined
    readonly statusLabel: string | undefined
    readonly needsAttention?: boolean
    readonly slug?: string
    readonly customName?: string
    readonly source?: string
  }
}

export type RemoteSessionNode = {
  readonly kind: 'remoteSession'
  readonly sessionId: string
  readonly status: string
  readonly subtitle: string | undefined
  readonly statusLabel: string | undefined
  readonly needsAttention?: boolean
  readonly workspaceName: string
  readonly source?: string
}

export type SectionNode = {
  readonly kind: 'section'
  readonly sectionType: 'local' | 'remote'
  readonly windowId?: string
  readonly workspaceName?: string
  readonly workspaceFolderPath?: string
  readonly branch?: string
}

export type TreeNode = TerminalNode | SessionNode | RemoteTerminalNode | RemoteSessionNode | SectionNode

/**
 * Owns session state, terminal correlation and the cross-window registry.
 *
 * It used to render the sidebar as a TreeView as well; the panel is a webview
 * now (see `panelProvider.ts`), which consumes this through `getSessions()` and
 * friends and renders from a pure view model.
 */
export class ClaudeTerminalProvider {
  /** Fired whenever the session set changes; the webview panel re-renders. */
  private readonly _changeEmitter = new vscode.EventEmitter<void>()

  readonly onDidChangeSessions = this._changeEmitter.event

  private readonly _disposables: vscode.Disposable[] = []

  private _sessions: ReadonlyArray<SessionRecord> = []

  private _remoteEntries: ReadonlyArray<WindowEntry> = []
  private _lastRemoteEntriesJson = '[]'

  private _currentWorkspaceName: string | undefined
  private _currentBranch: string | undefined

  /** Maps terminal process PID → Terminal object for synchronous lookup */
  private _terminalPidMap = new Map<number, vscode.Terminal>()

  /** Maps Terminal object → PID for synchronous reverse lookup */
  private _terminalToPidMap = new Map<vscode.Terminal, number>()

  /** Memoized `process.kill(pid, 0)` results, so pushes don't re-probe. */
  private _livenessCache = new Map<number, { alive: boolean; at: number }>()

  /** Tracks optimistic attention clears to prevent subscription callback overwrites */
  private _pendingAttentionClears = new Map<string, number>()

  /** Maps node identity key → 0-based shortcut index across all sections */
  private _shortcutIndexMap = new Map<string, number>()

  constructor(
    subscribeToSessions?: (
      callback: (sessions: ReadonlyArray<SessionRecord>) => void,
    ) => void,
    private readonly _correlateSession?: (
      pid: number,
      terminals: ReadonlyArray<vscode.Terminal>,
    ) => Promise<vscode.Terminal | undefined>,
    private readonly _onCorrelationResult?: (
      sessionId: string,
      terminalId: number,
    ) => void,
    private readonly _onTerminalClosed?: (terminalPid: number) => void,
    private readonly _workspaceState?: vscode.Memento,
    _extensionUri?: vscode.Uri,
  ) {
    this._initTerminalPidMap()

    this._disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        // Fire immediately so terminal appears in tree, then again after PID resolves
        this._refreshSections()
        void this._resolveTerminalPid(terminal).then((pid) => {
          if (pid !== undefined) {
            this._terminalPidMap.set(pid, terminal)
            this._terminalToPidMap.set(terminal, pid)
            this._tryCorrelateUnmatched()
            this._refreshSections()
          }
        })
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        const closedPid = this._terminalToPidMap.get(terminal)
        this._removeTerminalFromPidMap(terminal)
        if (closedPid !== undefined) {
          this._onTerminalClosed?.(closedPid)
        }
        // The agent dies with its tab, so any cached liveness is now stale.
        this._livenessCache.clear()
        this._refreshSections()
      }),
    )

    if (subscribeToSessions !== undefined) {
      subscribeToSessions((sessions) => {
        let filtered = sessions.filter((s) => s.status !== 'inactive')

        // Preserve pending attention clears that haven't been confirmed yet
        if (this._pendingAttentionClears.size > 0) {
          const toRemove: string[] = []
          filtered = filtered.map((session) => {
            const clearTime = this._pendingAttentionClears.get(session.sessionId)
            if (clearTime === undefined) return session
            if (!session.needsAttention) {
              // Backend confirmed the clear
              toRemove.push(session.sessionId)
              return session
            }
            if (session.lastEventAt > clearTime) {
              // A newer event arrived after our clear — respect it
              toRemove.push(session.sessionId)
              return session
            }
            // Still pending — preserve the local clear
            return { ...session, needsAttention: false }
          })
          for (const id of toRemove) {
            this._pendingAttentionClears.delete(id)
          }
        }

        this._sessions = filtered
        this._tryCorrelateUnmatched()
        this._refreshSections()
      })
    }
  }

  /** Async-resolve processId from a terminal, guarding against undefined processId in mocks */
  private _resolveTerminalPid(
    terminal: vscode.Terminal,
  ): Promise<number | undefined> {
    // terminal.processId is Thenable<number | undefined>; may be absent in test mocks
    const processId = terminal.processId as
      | Thenable<number | undefined>
      | undefined
    if (processId === undefined || typeof processId.then !== 'function') {
      return Promise.resolve(undefined)
    }
    return new Promise<number | undefined>((resolve) => {
      processId.then(resolve, () => resolve(undefined))
    })
  }

  /** Build initial terminal→PID map from currently open terminals */
  private _initTerminalPidMap(): void {
    const terminals = [...vscode.window.terminals]
    if (terminals.length === 0) return
    void Promise.all(
      terminals.map((terminal) =>
        this._resolveTerminalPid(terminal).then((pid) => {
          if (pid !== undefined) {
            this._terminalPidMap.set(pid, terminal)
            this._terminalToPidMap.set(terminal, pid)
          }
        }),
      ),
    ).then(() => {
      this._tryCorrelateUnmatched()
      this._refreshSections()
    })
  }

  private _removeTerminalFromPidMap(terminal: vscode.Terminal): void {
    for (const [pid, t] of this._terminalPidMap) {
      if (t === terminal) {
        this._terminalPidMap.delete(pid)
        break
      }
    }
    this._terminalToPidMap.delete(terminal)
  }

  /** Check if a process is still alive (signal 0 test) */
  private _isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Run correlateSession for all currently unmatched sessions */
  private _tryCorrelateUnmatched(): void {
    if (this._correlateSession === undefined) return
    for (const session of this._sessions) {
      if (
        session.terminalId === undefined ||
        !this._terminalPidMap.has(session.terminalId)
      ) {
        const terminals = [...vscode.window.terminals]
        void this._correlateSession(session.pid, terminals).then(
          async (terminal) => {
            if (terminal !== undefined) {
              const pid = await this._resolveTerminalPid(terminal)
              if (pid !== undefined) {
                this._terminalPidMap.set(pid, terminal)
                this._onCorrelationResult?.(session.sessionId, pid)
              }
            }
          },
        )
      }
    }
  }

  /** Look up PID for a terminal object (synchronous) */
  getTerminalPid(terminal: vscode.Terminal): number | undefined {
    return this._terminalToPidMap.get(terminal)
  }

  /** Look up the session record associated with a terminal (via PID mapping) */
  getSessionForTerminal(terminal: vscode.Terminal): SessionRecord | undefined {
    const pid = this._terminalToPidMap.get(terminal)
    if (pid === undefined) return undefined
    return this._sessions.find((session) => session.terminalId === pid)
  }

  /**
   * Sessions this window owns that are genuinely still running.
   *
   * A record outlives its process: closing the terminal tab kills the agent but
   * leaves the record behind until the reaper catches it. Filtering on real
   * liveness is what lets a closed session drop out of the live rows and come
   * back as a resumable one, instead of sitting there unfocusable forever.
   */
  getSessions(): ReadonlyArray<SessionRecord> {
    return this._sessions.filter(
      (record) => record.pid <= 0 || this._isProcessAliveCached(record.pid),
    )
  }

  /**
   * `process.kill(pid, 0)` is cheap but this runs on every panel push, which a
   * single turn triggers many times. One syscall per pid per second is plenty.
   */
  private _isProcessAliveCached(pid: number): boolean {
    const now = Date.now()
    const cached = this._livenessCache.get(pid)
    if (cached !== undefined && now - cached.at < LIVENESS_TTL_MS) {
      return cached.alive
    }
    const alive = this._isProcessAlive(pid)
    this._livenessCache.set(pid, { alive, at: now })
    return alive
  }

  /** Resolve the terminal hosting a session, via its correlated pid. */
  getTerminalForSession(sessionId: string): vscode.Terminal | undefined {
    const session = this._sessions.find((s) => s.sessionId === sessionId)
    if (session?.terminalId === undefined) return undefined
    return this._terminalPidMap.get(session.terminalId)
  }

  getWorkspaceName(): string | undefined {
    return this._currentWorkspaceName
  }

  getBranch(): string | undefined {
    return this._currentBranch
  }

  /** Live entries for the other VS Code windows, as last read from the registry. */
  getRemoteWindows(): ReadonlyArray<WindowEntry> {
    return this._remoteEntries
  }

  /** Every cwd this window knows about, used to shortcut history path decoding. */
  getKnownCwds(): readonly string[] {
    const cwds = new Set<string>()
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      cwds.add(folder.uri.fsPath)
    }
    for (const session of this._sessions) {
      if (session.cwd !== undefined) cwds.add(session.cwd)
    }
    for (const entry of this._remoteEntries) {
      if (entry.workspaceFolderPath !== undefined) cwds.add(entry.workspaceFolderPath)
    }
    return [...cwds]
  }

  /**
   * Flatten the window registry into per-session rows for the panel. Remote
   * fields are all optional on the wire, so a window running an older version
   * degrades to what it does publish rather than dropping out of the list.
   */
  getRemoteSessionInputs(): readonly RemoteSessionInput[] {
    if (!getShowTerminalsFromAllWindows()) return []
    const out: RemoteSessionInput[] = []
    for (const entry of this._remoteEntries) {
      for (const terminal of entry.terminals) {
        const session = terminal.session
        if (session === undefined) continue
        out.push({
          windowId: entry.windowId,
          socketPath: entry.socketPath,
          terminalName: terminal.name,
          terminalPid: terminal.pid,
          workspaceName: entry.workspaceName,
          workspaceFolderPath: entry.workspaceFolderPath,
          branch: session.customName ?? entry.branch,
          sessionId: session.sessionId,
          status: session.status,
          subtitle: session.subtitle,
          statusLabel: session.statusLabel,
          needsAttention: session.needsAttention ?? false,
          slug: session.slug,
          source: session.source ?? 'claude',
          cwd: session.cwd,
          backgroundTasks: session.backgroundTasks ?? 0,
          lastEventAt: session.lastEventAt,
        })
      }
    }
    return out
  }

  /**
   * Terminals with no agent session attached. Empty unless the user opted in
   * with `sidebar.showNonClaudeTerminals`.
   */
  getPlainTerminals(): readonly TerminalInput[] {
    if (!getShowNonClaudeTerminals()) return []
    const claimed = new Set<vscode.Terminal>()
    for (const session of this._sessions) {
      if (session.terminalId === undefined) continue
      const terminal = this._terminalPidMap.get(session.terminalId)
      if (terminal !== undefined) claimed.add(terminal)
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    return vscode.window.terminals
      .filter((terminal) => !claimed.has(terminal))
      .map((terminal) => ({
        pid: this._terminalToPidMap.get(terminal),
        name: terminal.name,
        cwd: folder,
      }))
  }

  getTerminalInfoForRegistry(): RemoteTerminalInfo[] {
    return vscode.window.terminals.map((terminal) => {
      const session = this._sessions.find(
        (s) =>
          s.terminalId !== undefined &&
          this._terminalPidMap.get(s.terminalId) === terminal,
      )
      const pid = this._terminalToPidMap.get(terminal)
      return {
        name: terminal.name,
        ...(pid !== undefined ? { pid } : {}),
        ...(session !== undefined
          ? {
              session: {
                sessionId: session.sessionId,
                status: session.status,
                subtitle: session.subtitle,
                statusLabel: session.statusLabel,
                needsAttention: session.needsAttention,
                ...(session.slug !== undefined ? { slug: session.slug } : {}),
                ...(session.customName !== undefined ? { customName: session.customName } : {}),
                source: session.source,
                ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
                backgroundTasks: session.backgroundTasks,
                lastEventAt: session.lastEventAt,
              },
            }
          : {}),
      }
    })
  }

  /** Return local terminal and session nodes */
  private _getLocalChildren(): TreeNode[] {
    const showAll = getShowNonClaudeTerminals()
    const result: TreeNode[] = []
    const terminalsWithSessions = new Set<vscode.Terminal>()

    for (const record of this._sessions) {
      if (record.pid > 0 && !this._isProcessAlive(record.pid)) continue

      if (record.terminalId !== undefined) {
        const terminal = this._terminalPidMap.get(record.terminalId)
        if (terminal === undefined) {
          result.push({ kind: 'session', record, terminal: undefined })
        } else {
          terminalsWithSessions.add(terminal)
          result.push({ kind: 'session', record, terminal })
        }
      } else {
        result.push({ kind: 'session', record, terminal: undefined })
      }
    }

    if (showAll) {
      for (const terminal of vscode.window.terminals) {
        if (!terminalsWithSessions.has(terminal)) {
          result.push({
            kind: 'terminal',
            terminal,
            pid: this._terminalToPidMap.get(terminal),
          })
        }
      }
    }

    return result
  }

  /** Get a child node by its 0-based shortcut index (across all sections) */
  getChildByIndex(index: number): TreeNode | undefined {
    const flatChildren = this._buildFlatChildren()
    return flatChildren[index]
  }

  /** Return remote terminal nodes for a specific window */
  private _getRemoteChildren(windowId: string): TreeNode[] {
    const entry = this._remoteEntries.find((e) => e.windowId === windowId)
    if (entry === undefined) return []

    const showAll = getShowNonClaudeTerminals()
    const terminals = showAll
      ? entry.terminals
      : entry.terminals.filter((t) => t.session !== undefined)

    return terminals.map((t) => ({
      kind: 'remoteTerminal' as const,
      windowId: entry.windowId,
      workspaceName: entry.workspaceName,
      ...(entry.workspaceFolderPath !== undefined
        ? { workspaceFolderPath: entry.workspaceFolderPath }
        : {}),
      terminalName: t.name,
      socketPath: entry.socketPath,
      ...(t.pid !== undefined ? { pid: t.pid } : {}),
      ...(t.session !== undefined ? { session: t.session } : {}),
    }))
  }



  /** Identity key for a tree node, used for shortcut index lookup */
  private _getNodeKey(node: TreeNode): string | undefined {
    switch (node.kind) {
      case 'session': return `s:${node.record.sessionId}`
      case 'terminal': return `t:${node.pid ?? node.terminal.name}`
      case 'remoteTerminal': return `rt:${node.windowId}:${node.terminalName}:${node.pid ?? ''}`
      case 'remoteSession': return `rs:${node.sessionId}`
      default: return undefined
    }
  }

  /** Build sorted root section nodes (shared between getChildren and index computation) */
  private _buildRootSections(): SectionNode[] {
    const sections: SectionNode[] = []

    sections.push({
      kind: 'section',
      sectionType: 'local',
      ...(this._currentWorkspaceName !== undefined ? { workspaceName: this._currentWorkspaceName } : {}),
      ...(this._currentBranch !== undefined ? { branch: this._currentBranch } : {}),
    })

    if (getShowTerminalsFromAllWindows()) {
      for (const entry of this._remoteEntries) {
        sections.push({
          kind: 'section',
          sectionType: 'remote',
          windowId: entry.windowId,
          workspaceName: entry.workspaceName,
          ...(entry.workspaceFolderPath !== undefined ? { workspaceFolderPath: entry.workspaceFolderPath } : {}),
          ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
        })
      }
    }

    sections.sort((sectionA, sectionB) => {
      const nameA = (sectionA.workspaceName ?? '').toLowerCase()
      const nameB = (sectionB.workspaceName ?? '').toLowerCase()
      const nameOrder = nameA.localeCompare(nameB)
      if (nameOrder !== 0) return nameOrder
      const branchA = (sectionA.branch ?? '').toLowerCase()
      const branchB = (sectionB.branch ?? '').toLowerCase()
      return branchA.localeCompare(branchB)
    })

    return sections
  }

  /** Build a flat list of all non-section children across all sections in display order */
  private _buildFlatChildren(): TreeNode[] {
    const sections = this._buildRootSections()
    const result: TreeNode[] = []
    for (const section of sections) {
      const children = section.sectionType === 'local'
        ? this._getLocalChildren()
        : section.windowId !== undefined
          ? this._getRemoteChildren(section.windowId)
          : []
      result.push(...children)
    }
    return result
  }

  /** Recompute the shortcut index map from the current tree state */
  private _recomputeShortcutIndices(): void {
    this._shortcutIndexMap.clear()
    const flatChildren = this._buildFlatChildren()
    for (let idx = 0; idx < flatChildren.length; idx++) {
      const key = this._getNodeKey(flatChildren[idx]!)
      if (key !== undefined) {
        this._shortcutIndexMap.set(key, idx)
      }
    }
  }

  /** Look up the shortcut index for a node */
  getShortcutIndex(node: TreeNode): number | undefined {
    const key = this._getNodeKey(node)
    if (key === undefined) return undefined
    return this._shortcutIndexMap.get(key)
  }


  getChildren(parent?: TreeNode): TreeNode[] {
    if (parent !== undefined) {
      if (parent.kind === 'section') {
        if (parent.sectionType === 'local') {
          return this._getLocalChildren()
        }
        if (parent.windowId !== undefined) {
          return this._getRemoteChildren(parent.windowId)
        }
        return []
      }

      return []
    }

    // Root level — return section nodes
    return this._buildRootSections()
  }

  private _refreshSections(): void {
    this._recomputeShortcutIndices()
    this._changeEmitter.fire()
  }

  /** Kept distinct from _refreshSections for callers that mean "sections changed". */
  private _refreshRoot(): void {
    this._refreshSections()
  }

  /** Optimistically clear needsAttention on a session and refresh the tree immediately */
  clearAttentionLocal(sessionId: string): void {
    const index = this._sessions.findIndex((session) => session.sessionId === sessionId)
    if (index === -1) return
    const session = this._sessions[index]
    if (session === undefined) return
    if (!session.needsAttention) return
    if (session.activeBlockingTool !== undefined) return
    this._pendingAttentionClears.set(sessionId, Date.now())
    const updated = [...this._sessions]
    updated[index] = { ...session, needsAttention: false } as SessionRecord
    this._sessions = updated
    this._refreshSections()
  }

  refresh(): void {
    this._refreshSections()
  }

  refreshRemoteTerminals(entries: ReadonlyArray<WindowEntry>): void {
    const serialized = JSON.stringify(entries)
    if (serialized === this._lastRemoteEntriesJson) return
    this._lastRemoteEntriesJson = serialized

    const structureChanged =
      entries.length !== this._remoteEntries.length ||
      entries.some((entry, idx) => entry.windowId !== this._remoteEntries[idx]?.windowId)

    const sectionLabelsChanged = !structureChanged && entries.some((entry, idx) => {
      const old = this._remoteEntries[idx]
      return old !== undefined && (
        entry.branch !== old.branch ||
        entry.workspaceName !== old.workspaceName
      )
    })

    this._remoteEntries = entries

    if (structureChanged || sectionLabelsChanged) {
      this._refreshRoot()
    } else {
      this._refreshSections()
    }
  }

  setBranchInfo(workspaceName: string | undefined, branch: string | undefined): void {
    if (this._currentWorkspaceName === workspaceName && this._currentBranch === branch) return
    this._currentWorkspaceName = workspaceName
    this._currentBranch = branch
    // Section labels change — need root refresh to rebuild section nodes
    this._refreshRoot()
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose()
    }
    this._disposables.length = 0
  }
}
