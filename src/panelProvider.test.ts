import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetConfiguration, mockRunTicketCommand } = vi.hoisted(() => ({
  mockGetConfiguration: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  mockRunTicketCommand: vi.fn(),
}))

vi.mock('./ticketProvider.js', () => ({ runTicketCommand: mockRunTicketCommand }))

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { path: string }, ...parts: string[]) => ({
      path: [base.path, ...parts].join('/'),
      toString: () => [base.path, ...parts].join('/'),
    }),
    parse: (s: string) => s,
  },
  EventEmitter: class {
    fire = vi.fn()
    event = vi.fn().mockReturnValue({ dispose: vi.fn() })
  },
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
  env: { openExternal: vi.fn().mockResolvedValue(true) },
  window: {
    activeTerminal: undefined,
    state: { focused: true },
    onDidChangeWindowState: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  workspace: {
    name: 'ws',
    workspaceFolders: [],
    getConfiguration: vi.fn().mockReturnValue({ get: mockGetConfiguration }),
  },
}))

import { PanelViewProvider } from './panelProvider.js'
import * as vscode from 'vscode'

const makeProvider = () =>
  ({
    onDidChangeSessions: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    getSessions: vi.fn().mockReturnValue([]),
    getRemoteSessionInputs: vi.fn().mockReturnValue([]),
    getKnownCwds: vi.fn().mockReturnValue([]),
    getPlainTerminals: vi.fn().mockReturnValue([]),
    getRemoteWindows: vi.fn().mockReturnValue([]),
    getWorkspaceName: vi.fn().mockReturnValue('ws'),
    getBranch: vi.fn().mockReturnValue('main'),
    getTerminalPid: vi.fn(),
    getTerminalForSession: vi.fn(),
    getShortcutIndexForSession: vi.fn(),
  }) as never

const makeState = () => {
  const store = new Map<string, unknown>()
  return {
    get: vi.fn((key: string, fallback?: unknown) => store.get(key) ?? fallback),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value)
      return Promise.resolve()
    }),
    keys: () => [...store.keys()],
  } as never
}

const makeWebview = () => ({
  options: {},
  html: '',
  cspSource: 'vscode-webview://abc',
  asWebviewUri: (uri: { toString: () => string }) =>
    ({ toString: () => `https://webview${uri.toString()}` }),
  postMessage: vi.fn().mockResolvedValue(true),
  onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
})

const makeView = (webview: ReturnType<typeof makeWebview>) => ({
  webview,
  visible: true,
  badge: undefined as unknown,
  onDidChangeVisibility: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  onDidDispose: vi.fn(),
})

const extensionUri = { path: '/ext' } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockGetConfiguration.mockImplementation(
    (_key: string, defaultValue: unknown) => defaultValue,
  )
})

describe('PanelViewProvider', () => {
  it('uses the view id the manifest declares', () => {
    expect(PanelViewProvider.viewType).toBe('claudeTerminalManagerPanel')
  })

  describe('webview html', () => {
    const html = (): string => {
      const panel = new PanelViewProvider(extensionUri, makeProvider(), makeState())
      const webview = makeWebview()
      panel.resolveWebviewView(makeView(webview) as never)
      panel.dispose()
      return webview.html
    }

    it('enables scripts and roots resources at the extension', () => {
      const panel = new PanelViewProvider(extensionUri, makeProvider(), makeState())
      const webview = makeWebview()
      panel.resolveWebviewView(makeView(webview) as never)
      expect(webview.options).toEqual({
        enableScripts: true,
        localResourceRoots: [extensionUri],
      })
      panel.dispose()
    })

    it('locks scripts to a nonce and forbids everything else by default', () => {
      const out = html()
      const nonceMatch = /script-src 'nonce-([A-Za-z0-9]{32})'/.exec(out)
      expect(nonceMatch).not.toBeNull()
      expect(out).toContain("default-src 'none'")
      // The script tag must carry the same nonce or it will not execute.
      expect(out).toContain(`<script nonce="${nonceMatch![1]!}"`)
    })

    it('mints a fresh nonce per resolve', () => {
      const first = /nonce-([A-Za-z0-9]{32})/.exec(html())![1]
      const second = /nonce-([A-Za-z0-9]{32})/.exec(html())![1]
      expect(first).not.toBe(second)
    })

    it('loads the bundled script and stylesheet through asWebviewUri', () => {
      const out = html()
      expect(out).toContain('https://webview/ext/out/webview.js')
      expect(out).toContain('https://webview/ext/media/panel.css')
    })

    it('always ships the view switch, with Tickets hidden until available', () => {
      const out = html()
      expect(out).toContain('<div class="seg"')
      expect(out).toContain('id="seg-active"')
      expect(out).toContain('id="seg-recent"')
      expect(out).toContain('id="seg-tickets" aria-selected="false" hidden')
    })
  })

  describe('state push', () => {
    const resolve = () => {
      const panel = new PanelViewProvider(extensionUri, makeProvider(), makeState())
      const webview = makeWebview()
      const view = makeView(webview)
      panel.resolveWebviewView(view as never)
      return { panel, webview, view }
    }

    it('posts a state message carrying the view model', () => {
      const { panel, webview } = resolve()
      panel.push()
      const message = webview.postMessage.mock.calls.at(-1)?.[0] as {
        type: string
        view: string
        model: { projects: unknown[]; ticketsAvailable: boolean }
      }
      expect(message.type).toBe('state')
      expect(message.view).toBe('active')
      expect(message.model.ticketsAvailable).toBe(false)
      panel.dispose()
    })

    it('keeps the last good tickets when a refresh fails', async () => {
      // A slow shell or a flaky ticket API must not make the tab disappear.
      const { panel, webview } = resolve()
      mockGetConfiguration.mockImplementation((key: string, fallback: unknown) =>
        key === 'tickets.command' ? 'echo' : fallback,
      )

      mockRunTicketCommand.mockResolvedValueOnce([
        { id: 'sc-1', state: 'In Development', title: 't', url: undefined, sessions: [] },
      ])
      await panel.refreshTickets()
      panel.push()
      const first = webview.postMessage.mock.calls.at(-1)?.[0] as {
        model: { ticketsAvailable: boolean; tickets: unknown[] }
      }
      expect(first.model.ticketsAvailable).toBe(true)

      mockRunTicketCommand.mockResolvedValueOnce(undefined)
      await panel.refreshTickets()
      panel.push()
      const second = webview.postMessage.mock.calls.at(-1)?.[0] as {
        model: { ticketsAvailable: boolean; tickets: unknown[] }
      }
      expect(second.model.ticketsAvailable).toBe(true)
      expect(second.model.tickets).toHaveLength(1)
      panel.dispose()
    })

    it('never runs the tickets command twice at once', async () => {
      const { panel } = resolve()
      mockGetConfiguration.mockImplementation((key: string, fallback: unknown) =>
        key === 'tickets.command' ? 'echo' : fallback,
      )
      let finish: (value: undefined) => void = () => {}
      mockRunTicketCommand.mockClear()
      mockRunTicketCommand.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        }),
      )
      const first = panel.refreshTickets()
      await panel.refreshTickets()
      expect(mockRunTicketCommand).toHaveBeenCalledTimes(1)
      finish(undefined)
      await first
      panel.dispose()
    })

    it('drops the tickets when the command is unset', async () => {
      const { panel, webview } = resolve()
      mockGetConfiguration.mockImplementation((key: string, fallback: unknown) =>
        key === 'tickets.command' ? 'echo' : fallback,
      )
      mockRunTicketCommand.mockResolvedValueOnce([])
      await panel.refreshTickets()

      mockGetConfiguration.mockImplementation(
        (_key: string, fallback: unknown) => fallback,
      )
      await panel.refreshTickets()
      panel.push()
      const message = webview.postMessage.mock.calls.at(-1)?.[0] as {
        model: { ticketsAvailable: boolean }
      }
      expect(message.model.ticketsAvailable).toBe(false)
      panel.dispose()
    })

    it('posts nothing to a hidden panel but still updates the badge', () => {
      const panel = new PanelViewProvider(extensionUri, makeProvider(), makeState())
      const webview = makeWebview()
      const view = makeView(webview)
      panel.resolveWebviewView(view as never)
      webview.postMessage.mockClear()
      view.visible = false
      view.badge = 'stale'
      panel.push()
      expect(
        webview.postMessage.mock.calls.filter(
          ([m]) => (m as { type: string }).type === 'state',
        ),
      ).toHaveLength(0)
      expect(view.badge).toBeUndefined()
      panel.dispose()
    })

    it('clears the badge when nothing needs attention', () => {
      const { panel, view } = resolve()
      panel.push()
      expect(view.badge).toBeUndefined()
      panel.dispose()
    })

    it('badges the activity bar with the attention count', () => {
      const provider = makeProvider() as unknown as {
        getSessions: ReturnType<typeof vi.fn>
      }
      provider.getSessions.mockReturnValue([
        {
          sessionId: 'a',
          status: 'waiting_for_input',
          pid: 1,
          subtitle: undefined,
          terminalId: undefined,
          customName: undefined,
          slug: 'one',
          cwd: '/x/repo',
          lastEventAt: 1,
          statusLabel: undefined,
          needsAttention: true,
          activeBlockingTool: undefined,
          source: 'claude',
          backgroundTasks: 0,
          idleWithBackground: false,
        },
      ])
      const panel = new PanelViewProvider(
        extensionUri,
        provider as never,
        makeState(),
      )
      const webview = makeWebview()
      const view = makeView(webview)
      panel.resolveWebviewView(view as never)
      panel.push()
      expect(view.badge).toEqual({
        value: 1,
        tooltip: '1 session is waiting for you',
      })
      panel.dispose()
    })

    it('re-indexes history once a live session disappears', () => {
      const provider = makeProvider() as unknown as {
        getSessions: ReturnType<typeof vi.fn>
      }
      const live = {
        sessionId: 'a',
        status: 'running',
        pid: 1,
        subtitle: undefined,
        terminalId: undefined,
        customName: undefined,
        slug: 'one',
        cwd: '/x/repo',
        lastEventAt: 1,
        statusLabel: undefined,
        needsAttention: false,
        activeBlockingTool: undefined,
        source: 'claude',
        backgroundTasks: 0,
        idleWithBackground: false,
      }
      provider.getSessions.mockReturnValue([live])
      const panel = new PanelViewProvider(
        extensionUri,
        provider as never,
        makeState(),
      )
      const webview = makeWebview()
      panel.resolveWebviewView(makeView(webview) as never)
      panel.push()

      const spy = vi.spyOn(panel, 'refreshHistory').mockResolvedValue()
      // The tab was closed: the process is gone, so the row is no longer live.
      provider.getSessions.mockReturnValue([])
      panel.push()

      expect(spy).toHaveBeenCalled()
      panel.dispose()
    })

    it('falls back to Active when Tickets is stored but unavailable', () => {
      const state = makeState() as unknown as {
        get: ReturnType<typeof vi.fn>
      }
      state.get.mockImplementation((key: string, fallback?: unknown) =>
        key === 'panel:view' ? 'tickets' : fallback,
      )
      const panel = new PanelViewProvider(
        extensionUri,
        makeProvider(),
        state as never,
      )
      const webview = makeWebview()
      panel.resolveWebviewView(makeView(webview) as never)
      panel.push()
      const message = webview.postMessage.mock.calls.at(-1)?.[0] as {
        view: string
      }
      expect(message.view).toBe('active')
      panel.dispose()
    })

    it('migrates the pre-split "projects" view to Active', () => {
      const state = makeState() as unknown as {
        get: ReturnType<typeof vi.fn>
      }
      state.get.mockImplementation((key: string, fallback?: unknown) =>
        key === 'panel:view' ? 'projects' : fallback,
      )
      const panel = new PanelViewProvider(
        extensionUri,
        makeProvider(),
        state as never,
      )
      const webview = makeWebview()
      panel.resolveWebviewView(makeView(webview) as never)
      panel.push()
      const message = webview.postMessage.mock.calls.at(-1)?.[0] as {
        view: string
      }
      expect(message.view).toBe('active')
      panel.dispose()
    })

    it('does nothing before the view is resolved', () => {
      const panel = new PanelViewProvider(extensionUri, makeProvider(), makeState())
      expect(() => panel.push()).not.toThrow()
      panel.dispose()
    })
  })

  describe('messages from the webview', () => {
    const send = async (message: unknown) => {
      const panel = new PanelViewProvider(extensionUri, makeProvider(), makeState())
      const webview = makeWebview()
      panel.resolveWebviewView(makeView(webview) as never)
      const handler = webview.onDidReceiveMessage.mock.calls[0]![0] as (
        m: unknown,
      ) => void
      handler(message)
      await Promise.resolve()
      await Promise.resolve()
      panel.dispose()
    }

    it.each([
      ['focus', 'claudeTerminalManager.focusSession'],
      ['resume', 'claudeTerminalManager.resumeSession'],
      ['close', 'claudeTerminalManager.closeSession'],
      ['rename', 'claudeTerminalManager.renameSessionById'],
    ])('routes %s to %s', async (type, command) => {
      await send({ type, id: 'sess-1' })
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        command,
        'sess-1',
      )
    })

    it('routes newSession with the project and its folder', async () => {
      // The folder is what lets the session open in that project's window.
      await send({ type: 'newSession', project: 'fstrz', folder: '/x/fstrz' })
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'claudeTerminalManager.newSession',
        'fstrz',
        '/x/fstrz',
      )
    })

    it('routes a bare newSession with no project', async () => {
      await send({ type: 'newSession' })
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'claudeTerminalManager.newSession',
        undefined,
        undefined,
      )
    })

    it('opens a ticket url externally', async () => {
      await send({ type: 'openTicket', url: 'https://example.test/sc-1' })
      expect(vscode.env.openExternal).toHaveBeenCalled()
    })
  })
})
