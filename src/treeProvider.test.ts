import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('vscode', () => ({
  window: {
    terminals: [] as Array<{ name: string }>,
    activeTerminal: undefined as unknown,
    onDidOpenTerminal: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidCloseTerminal: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(true),
    }),
  },
  Uri: {
    from: vi.fn((components: { scheme: string; path: string; query?: string }) => ({
      scheme: components.scheme,
      path: components.path,
      query: components.query ?? '',
      toString: () =>
        `${components.scheme}:${components.path}` +
        (components.query === undefined ? '' : `?${components.query}`),
    })),
    joinPath: vi.fn((base: { fsPath: string }, ...pathSegments: string[]) => ({
      fsPath: [base.fsPath, ...pathSegments].join('/'),
      toString: () => [base.fsPath, ...pathSegments].join('/'),
    })),
  },
  EventEmitter: class {
    event = vi.fn()
    fire = vi.fn()
    dispose = vi.fn()
  },
  TreeItem: class {
    label: string
    collapsibleState: number | undefined
    iconPath: unknown
    description: string | undefined = undefined
    contextValue: string | undefined = undefined
    command: unknown = undefined
    tooltip: unknown = undefined
    accessibilityInformation: unknown = undefined
    resourceUri: unknown = undefined
    constructor(label: string, collapsibleState?: number) {
      this.label = label
      this.collapsibleState = collapsibleState
    }
  },
  MarkdownString: class {
    value: string
    constructor(value: string) {
      this.value = value
    }
  },
  ThemeIcon: class {
    id: string
    constructor(id: string) {
      this.id = id
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
}))

vi.mock('./settings.js', () => ({
  getShowNonClaudeTerminals: vi.fn().mockReturnValue(true),
  getShowTerminalsFromAllWindows: vi.fn().mockReturnValue(false),
}))

import * as vscode from 'vscode'
import { ClaudeTerminalProvider } from './treeProvider.js'
import type { TerminalNode, SessionNode, RemoteTerminalNode, RemoteSessionNode, SectionNode } from './treeProvider.js'
import { getShowNonClaudeTerminals, getShowTerminalsFromAllWindows } from './settings.js'
import type { SessionRecord } from './stateMachine.js'
import type { WindowEntry } from './windowRegistry.js'

const makeRecord = (overrides?: Partial<SessionRecord>): SessionRecord => ({
  sessionId: 'abc12345def6',
  status: 'active',
  pid: process.pid,
  subtitle: undefined,
  terminalId: undefined,
  customName: undefined,
  slug: undefined,
  cwd: undefined,
  lastEventAt: 0,
  statusLabel: undefined,
  needsAttention: false,
  activeBlockingTool: undefined,
  source: 'claude',
  ...overrides,
})

const localSection: SectionNode = { kind: 'section', sectionType: 'local' }

beforeEach(() => {
  vi.clearAllMocks()
  ;(vscode.window as unknown as { terminals: unknown[]; activeTerminal: unknown }).terminals = []
  ;(vscode.window as unknown as { activeTerminal: unknown }).activeTerminal = undefined
  vi.mocked(vscode.window.onDidOpenTerminal).mockReturnValue({
    dispose: vi.fn(),
  } as never)
  vi.mocked(vscode.window.onDidCloseTerminal).mockReturnValue({
    dispose: vi.fn(),
  } as never)
  vi.mocked(getShowNonClaudeTerminals).mockReturnValue(true)
  vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(false)
})

describe('ClaudeTerminalProvider', () => {
  describe('getChildren (root level returns sections)', () => {
    it('returns Local section even when there are no terminals', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      const root = provider.getChildren()
      expect(root).toHaveLength(1)
      expect(root[0]).toEqual({ kind: 'section', sectionType: 'local' })
    })

    it('returns a Local section when there are terminals', () => {
      const t1 = { name: 'bash' }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [t1]
      const provider = new ClaudeTerminalProvider()
      const root = provider.getChildren()
      expect(root).toHaveLength(1)
      expect(root[0]).toMatchObject({ kind: 'section', sectionType: 'local' })
    })

    it('Local section children contain one TerminalNode per terminal (no sessions)', () => {
      const t1 = { name: 'bash' }
      const t2 = { name: 'zsh' }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [t1, t2]
      const provider = new ClaudeTerminalProvider()
      const result = provider.getChildren(localSection)
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ kind: 'terminal', terminal: t1 })
      expect(result[1]).toMatchObject({ kind: 'terminal', terminal: t2 })
    })

    it('returns [] for TerminalNode with no sessions', () => {
      const node = {
        kind: 'terminal' as const,
        terminal: { name: 'bash' },
        pid: undefined,
      }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        node.terminal,
      ]
      const provider = new ClaudeTerminalProvider()
      expect(provider.getChildren(node as never)).toEqual([])
    })
  })

  describe('event listeners', () => {
    it('onDidOpenTerminal fires the change emitter', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()

      const openListener =
        vi.mocked(vscode.window.onDidOpenTerminal).mock.calls[0]?.[0]
      expect(openListener).toBeDefined()

      const fireSpy = vi.spyOn(
        (provider as unknown as { _changeEmitter: { fire: () => void } })._changeEmitter,
        'fire',
      )
      openListener?.({} as never)

      expect(fireSpy).toHaveBeenCalledOnce()
    })

    it('onDidCloseTerminal fires the change emitter', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()

      const closeListener =
        vi.mocked(vscode.window.onDidCloseTerminal).mock.calls[0]?.[0]
      expect(closeListener).toBeDefined()

      const fireSpy = vi.spyOn(
        (provider as unknown as { _changeEmitter: { fire: () => void } })._changeEmitter,
        'fire',
      )
      closeListener?.({} as never)

      expect(fireSpy).toHaveBeenCalledOnce()
    })
  })

  describe('dispose', () => {
    it('dispose() disposes all terminal listeners', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []

      const openDispose = vi.fn()
      const closeDispose = vi.fn()
      vi.mocked(vscode.window.onDidOpenTerminal).mockReturnValueOnce({
        dispose: openDispose,
      } as never)
      vi.mocked(vscode.window.onDidCloseTerminal).mockReturnValueOnce({
        dispose: closeDispose,
      } as never)

      const provider = new ClaudeTerminalProvider()
      provider.dispose()

      expect(openDispose).toHaveBeenCalledOnce()
      expect(closeDispose).toHaveBeenCalledOnce()
    })

    it('dispose() is idempotent — calling twice does not throw', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      expect(() => {
        provider.dispose()
        provider.dispose()
      }).not.toThrow()
    })
  })

  describe('session support', () => {
    it('(a) active session without terminalId appears in Local section children', () => {
      const record = makeRecord({ status: 'active' })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))
      const root = provider.getChildren()
      expect(root).toHaveLength(1)
      expect(root[0]).toMatchObject({ kind: 'section', sectionType: 'local' })
      const children = provider.getChildren(localSection)
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({ kind: 'session', record })
    })

    it('(c) inactive sessions are excluded from the tree', () => {
      const active = makeRecord({ sessionId: 'session1', status: 'active' })
      const inactive = makeRecord({ sessionId: 'session2', status: 'inactive' })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) =>
        cb([active, inactive]),
      )
      const children = provider.getChildren(localSection)
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({ kind: 'session', record: active })
    })

    it('(d) showNonClaudeTerminals=false hides terminals but still shows sessions', () => {
      vi.mocked(getShowNonClaudeTerminals).mockReturnValue(false)
      const record = makeRecord({ status: 'active', terminalId: undefined })
      const terminal = { name: 'bash' }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        terminal,
      ]
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))
      const children = provider.getChildren(localSection)
      expect(children.some((n) => n.kind === 'session')).toBe(true)
      expect(children.some((n) => n.kind === 'terminal')).toBe(false)
    })

    it('(e) subscribe callback fires tree refresh', () => {
      let captured:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined
      const provider = new ClaudeTerminalProvider((cb) => {
        captured = cb
      })
      const fireSpy = vi.spyOn(
        (provider as unknown as { _changeEmitter: { fire: () => void } })._changeEmitter,
        'fire',
      )
      const record = makeRecord({ status: 'active' })
      captured?.([record])
      expect(fireSpy).toHaveBeenCalled()
    })

    it('session with dead process is filtered out but Local section still shown', () => {
      const deadPid = 2147483647 // max PID, extremely unlikely to be in use
      const record = makeRecord({ pid: deadPid, terminalId: undefined })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))
      const root = provider.getChildren()
      // Local section is always shown, but dead-process sessions produce no children
      expect(root).toHaveLength(1)
      expect(root[0]).toMatchObject({ kind: 'section', sectionType: 'local' })
      const children = provider.getChildren(root[0])
      expect(children).toHaveLength(0)
    })
  })

  // ─── T1.12 tests ──────────────────────────────────────────────────────────

  describe('terminal correlation (T1.12)', () => {
    it('(a) session with terminalId appears in Local section with terminal reference', async () => {
      const terminal = {
        name: 'bash',
        processId: Promise.resolve(1234),
      }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        terminal,
      ]
      const record = makeRecord({ terminalId: 1234 })
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      // Wait for _initTerminalPidMap to resolve processId
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      const children = provider.getChildren(localSection)
      const sessionNode = children.find((n) => n.kind === 'session') as SessionNode | undefined
      expect(sessionNode).toBeDefined()
      expect(sessionNode!.terminal).toBe(terminal as never)
    })

    it('(b) session without terminalId appears in Local section', () => {
      const record = makeRecord({ terminalId: undefined })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      const children = provider.getChildren(localSection)
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({ kind: 'session', record })
    })

    it('(c) retry correlation fires for each new event on unmatched session', async () => {
      const mockCorrelate = vi.fn<
        (
          pid: number,
          terminals: ReadonlyArray<vscode.Terminal>,
        ) => Promise<vscode.Terminal | undefined>
      >().mockResolvedValue(undefined)

      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined

      const provider = new ClaudeTerminalProvider(
        (cb) => {
          sessionCallback = cb
        },
        mockCorrelate,
      )

      const record = makeRecord({ pid: process.pid, terminalId: undefined })

      // First event
      sessionCallback?.([record])
      expect(mockCorrelate).toHaveBeenCalledTimes(1)
      expect(mockCorrelate).toHaveBeenCalledWith(
        process.pid,
        expect.any(Array),
      )

      // Second event (new event for same unmatched session — retry)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      vi.clearAllMocks()
      sessionCallback?.([record])
      expect(mockCorrelate).toHaveBeenCalledTimes(1)
    })

    it('(c2) a burst of events runs one walk, then one re-run', async () => {
      let finish: (value: undefined) => void = () => {}
      const mockCorrelate = vi.fn<
        (
          pid: number,
          terminals: ReadonlyArray<vscode.Terminal>,
        ) => Promise<vscode.Terminal | undefined>
      >()
      mockCorrelate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      mockCorrelate.mockResolvedValue(undefined)

      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined
      new ClaudeTerminalProvider((cb) => {
        sessionCallback = cb
      }, mockCorrelate)

      const record = makeRecord({ pid: process.pid, terminalId: undefined })
      for (let i = 0; i < 50; i++) sessionCallback?.([record])
      expect(mockCorrelate).toHaveBeenCalledTimes(1)

      finish(undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(mockCorrelate).toHaveBeenCalledTimes(2)
    })

    it('(d) after correlation succeeds, session gets terminal reference', async () => {
      const terminal = { name: 'bash', processId: Promise.resolve(1234) }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        terminal,
      ]

      let resolveCorrelate!: (value: vscode.Terminal | undefined) => void
      const mockCorrelate = vi.fn<
        (
          pid: number,
          terminals: ReadonlyArray<vscode.Terminal>,
        ) => Promise<vscode.Terminal | undefined>
      >().mockReturnValue(
        new Promise<vscode.Terminal | undefined>((resolve) => {
          resolveCorrelate = resolve
        }),
      )

      const onCorrelation = vi.fn<
        (sessionId: string, terminalId: number) => void
      >()

      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined

      const provider = new ClaudeTerminalProvider(
        (cb) => {
          sessionCallback = cb
        },
        mockCorrelate,
        onCorrelation,
      )

      const record = makeRecord({ pid: process.pid, terminalId: undefined })
      sessionCallback?.([record])

      // Before correlation: session appears without terminal
      const childrenBefore = provider.getChildren(localSection)
      const sessionBefore = childrenBefore.find((n) => n.kind === 'session') as SessionNode | undefined
      expect(sessionBefore).toBeDefined()
      expect(sessionBefore!.terminal).toBeUndefined()

      // Resolve correlation with the terminal
      resolveCorrelate(terminal as unknown as vscode.Terminal)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      // onCorrelationResult should have been called with (sessionId, terminalPid)
      expect(onCorrelation).toHaveBeenCalledWith(record.sessionId, 1234)

      // Simulate SessionManager updating terminalId and firing changes
      sessionCallback?.([{ ...record, terminalId: 1234 }])

      // After correlation, session now has terminal reference
      const childrenAfter = provider.getChildren(localSection)
      const sessionAfter = childrenAfter.find((n) => n.kind === 'session') as SessionNode | undefined
      expect(sessionAfter).toBeDefined()
      expect(sessionAfter!.terminal).toBe(terminal as never)
    })

    it('showNonClaudeTerminals=false still shows session in Local section', async () => {
      vi.mocked(getShowNonClaudeTerminals).mockReturnValue(false)
      const terminal = { name: 'bash', processId: Promise.resolve(4321) }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        terminal,
      ]
      const record = makeRecord({ terminalId: 4321 })
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      const children = provider.getChildren(localSection)
      expect(children.some((n) => n.kind === 'session')).toBe(true)
      // Terminal node is NOT shown since showNonClaudeTerminals=false
      expect(children.some((n) => n.kind === 'terminal')).toBe(false)
    })

    it('session with terminalId not in map is shown as uncorrelated', () => {
      // Terminal PID not in _terminalPidMap (e.g., terminal was closed)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const record = makeRecord({ terminalId: 9999 })
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      const root = provider.getChildren()
      expect(root).toHaveLength(1)
      expect(root[0]).toMatchObject({ kind: 'section', sectionType: 'local' })
      const children = provider.getChildren(root[0])
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({ kind: 'session', record, terminal: undefined })
    })

    it('multiple unmatched sessions appear in Local section', () => {
      const r1 = makeRecord({ sessionId: 's1', terminalId: undefined })
      const r2 = makeRecord({ sessionId: 's2', terminalId: undefined })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) => cb([r1, r2]))

      const children = provider.getChildren(localSection)
      const sessions = children.filter((n) => n.kind === 'session')
      expect(sessions).toHaveLength(2)
    })
  })

  // ─── T2.2 tests ───────────────────────────────────────────────────────────

  describe('terminal rename (T2.2)', () => {
    it('(c) getChildren sets pid from _terminalToPidMap on TerminalNode', async () => {
      const terminal = { name: 'bash', processId: Promise.resolve(9999) }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        terminal,
      ]
      const provider = new ClaudeTerminalProvider()

      // Wait for _initTerminalPidMap to resolve processId
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      const children = provider.getChildren(localSection)
      expect(children).toHaveLength(1)
      const terminalNode = children[0] as TerminalNode
      expect(terminalNode.kind).toBe('terminal')
      expect(terminalNode.pid).toBe(9999)
    })

    it('(c2) getChildren sets pid=undefined when terminal processId not yet resolved', () => {
      const terminal = { name: 'bash' } // no processId
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        terminal,
      ]
      const provider = new ClaudeTerminalProvider()

      const children = provider.getChildren(localSection)
      expect(children).toHaveLength(1)
      const terminalNode = children[0] as TerminalNode
      expect(terminalNode.kind).toBe('terminal')
      expect(terminalNode.pid).toBeUndefined()
    })
  })

  // ─── T3.2 tests ───────────────────────────────────────────────────────────

  describe('terminal rename bidirectional sync (T3.2)', () => {
    const makeWs = (
      nameValue: string | undefined,
      origNameValue: string | undefined,
    ) => ({
      get: vi.fn<(key: string) => string | undefined>().mockImplementation(
        (key) => {
          if (key === 'terminal:name:1234') return nameValue
          if (key === 'terminal:orig-name:1234') return origNameValue
          return undefined
        },
      ),
      update: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      keys: vi.fn<() => readonly string[]>().mockReturnValue([]),
    })

  })

  // ─── T2.6 tests ───────────────────────────────────────────────────────────

  describe('remote terminals (T2.6)', () => {
    const makeEntry = (overrides?: Partial<WindowEntry>): WindowEntry => ({
      windowId: 'win-2',
      workspaceName: 'other-project',
      socketPath: '/tmp/vscode-claude-2.sock',
      terminals: [{ name: 'bash' }],
      lastHeartbeat: Date.now(),
      ...overrides,
    })

    it('(a) getChildren returns remote SectionNode when showTerminalsFromAllWindows=true', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([makeEntry()])

      const root = provider.getChildren()
      expect(root.some((n) => n.kind === 'section' && n.sectionType === 'remote')).toBe(true)
      const remoteSection = root.find(
        (n) => n.kind === 'section' && n.sectionType === 'remote',
      ) as SectionNode
      expect(remoteSection.workspaceName).toBe('other-project')
      expect(remoteSection.windowId).toBe('win-2')
    })

    it('(a1) remote SectionNode includes workspaceFolderPath from WindowEntry', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([
        makeEntry({ workspaceFolderPath: '/home/user/other-project' }),
      ])

      const root = provider.getChildren()
      const remoteSection = root.find(
        (n) => n.kind === 'section' && n.sectionType === 'remote',
      ) as SectionNode
      expect(remoteSection.workspaceFolderPath).toBe('/home/user/other-project')
    })

    it('(a2) remote section children contain RemoteTerminalNodes', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([makeEntry()])

      const remoteSection: SectionNode = {
        kind: 'section',
        sectionType: 'remote',
        windowId: 'win-2',
        workspaceName: 'other-project',
      }
      const children = provider.getChildren(remoteSection)
      expect(children).toHaveLength(1)
      const remote = children[0] as RemoteTerminalNode
      expect(remote.kind).toBe('remoteTerminal')
      expect(remote.terminalName).toBe('bash')
      expect(remote.workspaceName).toBe('other-project')
      expect(remote.windowId).toBe('win-2')
    })

    it('(b) getChildren does NOT return remote sections when showTerminalsFromAllWindows=false', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(false)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([makeEntry()])

      const root = provider.getChildren()
      expect(root.some((n) => n.kind === 'section' && (n as SectionNode).sectionType === 'remote')).toBe(false)
    })

    it('(f) refreshRemoteTerminals updates _remoteEntries and fires the event emitter', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      const fireSpy = vi.spyOn(
        (provider as unknown as { _changeEmitter: { fire: () => void } })._changeEmitter,
        'fire',
      )

      provider.refreshRemoteTerminals([makeEntry()])

      expect(fireSpy).toHaveBeenCalled()
      const stored = (
        provider as unknown as { _remoteEntries: ReadonlyArray<WindowEntry> }
      )._remoteEntries
      expect(stored).toHaveLength(1)
    })

    it('(g2) showNonClaudeTerminals=false hides remote terminals without sessions', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      vi.mocked(getShowNonClaudeTerminals).mockReturnValue(false)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([
        makeEntry({
          terminals: [
            { name: 'bash' },
            {
              name: 'claude',
              session: {
                sessionId: 'sess1',
                status: 'active',
                subtitle: undefined,
                statusLabel: undefined,
              },
            },
          ],
        }),
      ])

      const remoteSection: SectionNode = {
        kind: 'section',
        sectionType: 'remote',
        windowId: 'win-2',
        workspaceName: 'other-project',
      }
      const children = provider.getChildren(remoteSection)
      expect(children).toHaveLength(1)
      const remote = children[0] as RemoteTerminalNode
      expect(remote.terminalName).toBe('claude')
      expect(remote.session).toBeDefined()
    })

    it('(g3) showNonClaudeTerminals=false still shows remote section when no sessions exist', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      vi.mocked(getShowNonClaudeTerminals).mockReturnValue(false)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([
        makeEntry({ terminals: [{ name: 'bash' }, { name: 'zsh' }] }),
      ])

      const root = provider.getChildren()
      // Remote section is always shown so the user can see idle windows
      expect(
        root.some((n) => n.kind === 'section' && n.sectionType === 'remote'),
      ).toBe(true)
      // But it has no children since showNonClaudeTerminals=false and no sessions
      const remoteSection = root.find(
        (n) => n.kind === 'section' && n.sectionType === 'remote',
      )!
      const children = provider.getChildren(remoteSection)
      expect(children).toHaveLength(0)
    })

    it('(g4) showNonClaudeTerminals=true shows all remote terminals', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      vi.mocked(getShowNonClaudeTerminals).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([
        makeEntry({
          terminals: [
            { name: 'bash' },
            {
              name: 'claude',
              session: {
                sessionId: 'sess1',
                status: 'active',
                subtitle: undefined,
                statusLabel: undefined,
              },
            },
          ],
        }),
      ])

      const remoteSection: SectionNode = {
        kind: 'section',
        sectionType: 'remote',
        windowId: 'win-2',
        workspaceName: 'other-project',
      }
      const children = provider.getChildren(remoteSection)
      expect(children).toHaveLength(2)
    })

    it('(g) remote section with 2 terminals returns 2 RemoteTerminalNodes as children', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([
        makeEntry({ terminals: [{ name: 'bash' }, { name: 'zsh' }] }),
      ])

      const remoteSection: SectionNode = {
        kind: 'section',
        sectionType: 'remote',
        windowId: 'win-2',
        workspaceName: 'other-project',
      }
      const children = provider.getChildren(remoteSection)
      const remotes = children.filter((n) => n.kind === 'remoteTerminal')
      expect(remotes).toHaveLength(2)
    })

    it('(h) branch change on remote entry updates section label via root refresh', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()

      // Initial load with branch "main"
      provider.refreshRemoteTerminals([makeEntry({ branch: 'main' })])
      const rootBefore = provider.getChildren()
      const sectionBefore = rootBefore.find(
        (n) => n.kind === 'section' && n.sectionType === 'remote',
      ) as SectionNode
      expect(sectionBefore.branch).toBe('main')

      // Update with branch "feature-x" — same windowId, same count
      provider.refreshRemoteTerminals([makeEntry({ branch: 'feature-x' })])
      const rootAfter = provider.getChildren()
      const sectionAfter = rootAfter.find(
        (n) => n.kind === 'section' && n.sectionType === 'remote',
      ) as SectionNode
      expect(sectionAfter.branch).toBe('feature-x')
    })
  })

  // ─── Section ordering tests ─────────────────────────────────────────────

  describe('section ordering', () => {
    const makeEntry = (overrides?: Partial<WindowEntry>): WindowEntry => ({
      windowId: 'win-2',
      workspaceName: 'other-project',
      socketPath: '/tmp/vscode-claude-2.sock',
      terminals: [{ name: 'bash' }],
      lastHeartbeat: Date.now(),
      ...overrides,
    })

    it('multiple remote windows are sorted alphabetically by workspaceName', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.setBranchInfo('local-project', 'main')
      provider.refreshRemoteTerminals([
        makeEntry({ windowId: 'win-z', workspaceName: 'zeta-project' }),
        makeEntry({ windowId: 'win-a', workspaceName: 'alpha-project' }),
        makeEntry({ windowId: 'win-m', workspaceName: 'mu-project' }),
      ])

      const root = provider.getChildren()
      const names = root.map((node) => (node as SectionNode).workspaceName)
      expect(names).toEqual(['alpha-project', 'local-project', 'mu-project', 'zeta-project'])
    })

    it('local window is interleaved based on its workspaceName, not always first', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.setBranchInfo('my-project', 'main')
      provider.refreshRemoteTerminals([
        makeEntry({ windowId: 'win-a', workspaceName: 'alpha-project' }),
        makeEntry({ windowId: 'win-z', workspaceName: 'zeta-project' }),
      ])

      const root = provider.getChildren()
      const names = root.map((node) => (node as SectionNode).workspaceName ?? 'Local')
      expect(names).toEqual(['alpha-project', 'my-project', 'zeta-project'])
    })

    it('when workspaceNames match, branch is used as tiebreaker', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.setBranchInfo('shared-project', 'feature-b')
      provider.refreshRemoteTerminals([
        makeEntry({ windowId: 'win-1', workspaceName: 'shared-project', branch: 'feature-a' }),
        makeEntry({ windowId: 'win-2', workspaceName: 'shared-project', branch: 'main' }),
      ])

      const root = provider.getChildren()
      const branches = root.map((node) => (node as SectionNode).branch ?? '')
      expect(branches).toEqual(['feature-a', 'feature-b', 'main'])
    })

    it('absent branch sorts before present branch', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.setBranchInfo('same-project', undefined)
      provider.refreshRemoteTerminals([
        makeEntry({ windowId: 'win-1', workspaceName: 'same-project', branch: 'develop' }),
      ])

      const root = provider.getChildren()
      const branches = root.map((node) => (node as SectionNode).branch)
      // undefined (local, no branch) sorts before 'develop'
      expect(branches).toEqual([undefined, 'develop'])
    })

    it('hyphenated name without suffix sorts before same name with suffix (rhino-core before rhino-core-2)', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.setBranchInfo('jm-vscode-improver', 'master')
      provider.refreshRemoteTerminals([
        makeEntry({ windowId: 'win-2', workspaceName: 'rhino-core-2' }),
        makeEntry({ windowId: 'win-b', workspaceName: 'rhino-core-backup' }),
        makeEntry({ windowId: 'win-1', workspaceName: 'rhino-core' }),
      ])

      const root = provider.getChildren()
      const names = root.map((node) => (node as SectionNode).workspaceName)
      expect(names).toEqual(['jm-vscode-improver', 'rhino-core', 'rhino-core-2', 'rhino-core-backup'])
    })

    it('rhino-core without suffix sorts before rhino-core-2 even when both have branches', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.setBranchInfo('jm-vscode-improver', 'master')
      provider.refreshRemoteTerminals([
        makeEntry({ windowId: 'win-2', workspaceName: 'rhino-core-2', branch: 'implement-ticket-v3-kanban' }),
        makeEntry({ windowId: 'win-3', workspaceName: 'rhino-core-3', branch: 'implement-ticket-v3-kanban' }),
        makeEntry({ windowId: 'win-4', workspaceName: 'rhino-core-4', branch: 'review-on-gh' }),
        makeEntry({ windowId: 'win-1', workspaceName: 'rhino-core', branch: 'implement-ticket-v3-kanban' }),
      ])

      const root = provider.getChildren()
      const names = root.map((node) => (node as SectionNode).workspaceName)
      expect(names).toEqual(['jm-vscode-improver', 'rhino-core', 'rhino-core-2', 'rhino-core-3', 'rhino-core-4'])
    })
  })

  // ─── clearAttentionLocal tests ──────────────────────────────────────────

  describe('clearAttentionLocal', () => {
    it('clears needsAttention and fires tree refresh', () => {
      const record = makeRecord({ sessionId: 'sess1', status: 'waiting_for_input', needsAttention: true })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      const fireSpy = vi.spyOn(
        (provider as unknown as { _changeEmitter: { fire: () => void } })._changeEmitter,
        'fire',
      )
      fireSpy.mockClear()

      provider.clearAttentionLocal('sess1')

      expect(fireSpy).toHaveBeenCalled()
      // Verify the session now has needsAttention=false
      const children = provider.getChildren(localSection)
      const sessionNode = children.find((n) => n.kind === 'session') as SessionNode | undefined
      expect(sessionNode).toBeDefined()
      expect(sessionNode!.record.needsAttention).toBe(false)
    })

    it('is a no-op when session not found', () => {
      const record = makeRecord({ sessionId: 'sess1', needsAttention: true })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      const fireSpy = vi.spyOn(
        (provider as unknown as { _changeEmitter: { fire: () => void } })._changeEmitter,
        'fire',
      )
      fireSpy.mockClear()

      provider.clearAttentionLocal('nonexistent')
      expect(fireSpy).not.toHaveBeenCalled()
    })

    it('is a no-op when activeBlockingTool is set', () => {
      const record = makeRecord({ sessionId: 'sess1', status: 'waiting_for_input', needsAttention: true, activeBlockingTool: 'AskUserQuestion' })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      const fireSpy = vi.spyOn(
        (provider as unknown as { _changeEmitter: { fire: () => void } })._changeEmitter,
        'fire',
      )
      fireSpy.mockClear()

      provider.clearAttentionLocal('sess1')
      expect(fireSpy).not.toHaveBeenCalled()

      // Verify attention is still set
      const children = provider.getChildren(localSection)
      const sessionNode = children.find((n) => n.kind === 'session') as SessionNode | undefined
      expect(sessionNode).toBeDefined()
      expect(sessionNode!.record.needsAttention).toBe(true)
    })

    it('is a no-op when needsAttention is already false', () => {
      const record = makeRecord({ sessionId: 'sess1', needsAttention: false })
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      const fireSpy = vi.spyOn(
        (provider as unknown as { _changeEmitter: { fire: () => void } })._changeEmitter,
        'fire',
      )
      fireSpy.mockClear()

      provider.clearAttentionLocal('sess1')
      expect(fireSpy).not.toHaveBeenCalled()
    })

  })

  // ─── pending attention clears tests ─────────────────────────────────────

  describe('pending attention clears', () => {
    it('pending clear survives subscription callback overwrite', () => {
      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const record = makeRecord({ sessionId: 'sess1', status: 'waiting_for_input', needsAttention: true, lastEventAt: 100 })
      const provider = new ClaudeTerminalProvider((cb) => {
        sessionCallback = cb
      })

      // Initial session push
      sessionCallback?.([record])

      // Clear attention locally
      provider.clearAttentionLocal('sess1')

      // Verify cleared
      const childrenAfterClear = provider.getChildren(localSection)
      const nodeAfterClear = childrenAfterClear[0] as SessionNode
      expect(nodeAfterClear.record.needsAttention).toBe(false)

      // Subscription callback fires again with stale state (needsAttention still true, same lastEventAt)
      sessionCallback?.([record])

      // Pending clear should prevent overwrite
      const childrenAfterOverwrite = provider.getChildren(localSection)
      const nodeAfterOverwrite = childrenAfterOverwrite[0] as SessionNode
      expect(nodeAfterOverwrite.record.needsAttention).toBe(false)
    })

    it('pending clear is removed when backend confirms (needsAttention=false)', () => {
      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const record = makeRecord({ sessionId: 'sess1', status: 'waiting_for_input', needsAttention: true, lastEventAt: 100 })
      const provider = new ClaudeTerminalProvider((cb) => {
        sessionCallback = cb
      })

      sessionCallback?.([record])
      provider.clearAttentionLocal('sess1')

      // Backend confirms with needsAttention=false
      const confirmedRecord = { ...record, needsAttention: false }
      sessionCallback?.([confirmedRecord])

      // Pending clear should be removed
      const pendingClears = (provider as unknown as { _pendingAttentionClears: Map<string, number> })._pendingAttentionClears
      expect(pendingClears.has('sess1')).toBe(false)
    })

    it('pending clear is removed when superseded by a newer event', () => {
      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const record = makeRecord({ sessionId: 'sess1', status: 'waiting_for_input', needsAttention: true, lastEventAt: 100 })
      const provider = new ClaudeTerminalProvider((cb) => {
        sessionCallback = cb
      })

      sessionCallback?.([record])
      provider.clearAttentionLocal('sess1')

      // A newer event arrives with needsAttention=true and a later timestamp
      const newerRecord = { ...record, needsAttention: true, lastEventAt: Date.now() + 10000 }
      sessionCallback?.([newerRecord])

      // The newer event should supersede the pending clear
      const children = provider.getChildren(localSection)
      const node = children[0] as SessionNode
      expect(node.record.needsAttention).toBe(true)

      // Pending clear should be removed
      const pendingClears = (provider as unknown as { _pendingAttentionClears: Map<string, number> })._pendingAttentionClears
      expect(pendingClears.has('sess1')).toBe(false)
    })

    it('multiple clears for different sessions work independently', () => {
      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const record1 = makeRecord({ sessionId: 'sess1', status: 'waiting_for_input', needsAttention: true, lastEventAt: 100 })
      const record2 = makeRecord({ sessionId: 'sess2', status: 'waiting_for_input', needsAttention: true, lastEventAt: 100 })
      const provider = new ClaudeTerminalProvider((cb) => {
        sessionCallback = cb
      })

      sessionCallback?.([record1, record2])

      // Clear only sess1
      provider.clearAttentionLocal('sess1')

      // Subscription callback fires again with stale state for both
      sessionCallback?.([record1, record2])

      const children = provider.getChildren(localSection)
      const node1 = children.find((n) => n.kind === 'session' && n.record.sessionId === 'sess1') as SessionNode
      const node2 = children.find((n) => n.kind === 'session' && n.record.sessionId === 'sess2') as SessionNode
      expect(node1.record.needsAttention).toBe(false)
      expect(node2.record.needsAttention).toBe(true)
    })
  })

  // ─── getSessionForTerminal tests ────────────────────────────────────────

  describe('getSessionForTerminal', () => {
    it('returns session when terminal is correlated via PID', async () => {
      const terminal = { name: 'bash', processId: Promise.resolve(1234) }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [terminal]
      const record = makeRecord({ terminalId: 1234 })
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      // Wait for _initTerminalPidMap to resolve
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      const result = provider.getSessionForTerminal(terminal as never)
      expect(result).toBeDefined()
      expect(result!.sessionId).toBe(record.sessionId)
    })

    it('returns undefined when terminal has no PID mapping', () => {
      const terminal = { name: 'bash' } // no processId
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [terminal]
      const record = makeRecord({ terminalId: 1234 })
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      const result = provider.getSessionForTerminal(terminal as never)
      expect(result).toBeUndefined()
    })

    it('returns undefined when no session matches the PID', async () => {
      const terminal = { name: 'bash', processId: Promise.resolve(9999) }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [terminal]
      const record = makeRecord({ terminalId: 1234 }) // different PID
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      // Wait for _initTerminalPidMap to resolve
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      const result = provider.getSessionForTerminal(terminal as never)
      expect(result).toBeUndefined()
    })
  })

  // ─── T3.4 tests ───────────────────────────────────────────────────────────

  describe('session detection fixes (T3.4)', () => {
    it('(a) showNonClaudeTerminals=false shows sessions but not terminals in Local section', () => {
      vi.mocked(getShowNonClaudeTerminals).mockReturnValue(false)
      const record = makeRecord({ status: 'active', terminalId: undefined })
      const terminal = { name: 'bash' }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        terminal,
      ]
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))
      const children = provider.getChildren(localSection)
      expect(children.some((n) => n.kind === 'session')).toBe(true)
      expect(children.some((n) => n.kind === 'terminal')).toBe(false)
    })

    it('(b) showNonClaudeTerminals=false still returns Local section when no sessions', () => {
      vi.mocked(getShowNonClaudeTerminals).mockReturnValue(false)
      const terminal = { name: 'bash' }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        terminal,
      ]
      const provider = new ClaudeTerminalProvider() // no sessions
      const root = provider.getChildren()
      // Local section always shown so the user can see idle windows
      expect(root).toHaveLength(1)
      expect(root[0]).toMatchObject({ kind: 'section', sectionType: 'local' })
      // But no children since showNonClaudeTerminals=false and no sessions
      const children = provider.getChildren(root[0])
      expect(children).toHaveLength(0)
    })

    it('(c) showNonClaudeTerminals=false only shows sessions (not their terminals)', async () => {
      vi.mocked(getShowNonClaudeTerminals).mockReturnValue(false)
      const t1 = { name: 'bash', processId: Promise.resolve(1111) }
      const t2 = { name: 'zsh', processId: Promise.resolve(2222) }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        t1,
        t2,
      ]
      // Only t1 has a correlated session
      const record = makeRecord({ terminalId: 1111 })
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))

      // Wait for _initTerminalPidMap to resolve
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      const children = provider.getChildren(localSection)
      // Session appears
      expect(children.some((n) => n.kind === 'session')).toBe(true)
      // No terminal nodes when showNonClaudeTerminals=false
      expect(children.filter((n) => n.kind === 'terminal')).toHaveLength(0)
    })

    it('(d) correlation is retried when terminal PID resolves after session arrives', async () => {
      const mockCorrelate = vi.fn<
        (
          pid: number,
          terminals: ReadonlyArray<vscode.Terminal>,
        ) => Promise<vscode.Terminal | undefined>
      >().mockResolvedValue(undefined)

      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined

      const provider = new ClaudeTerminalProvider(
        (cb) => {
          sessionCallback = cb
        },
        mockCorrelate,
      )

      // Capture the open listener before any clears
      const openListener =
        vi.mocked(vscode.window.onDidOpenTerminal).mock.calls[0]?.[0]
      expect(openListener).toBeDefined()

      // Session arrives: unmatched (terminalId undefined)
      const record = makeRecord({ pid: process.pid, terminalId: undefined })
      sessionCallback?.([record])

      // Correlate should be called once from session update
      expect(mockCorrelate).toHaveBeenCalledTimes(1)
      mockCorrelate.mockClear()

      // Simulate terminal opening with a PID that will resolve asynchronously
      const terminalWithPid = { name: 'bash', processId: Promise.resolve(5555) }
      openListener?.(terminalWithPid as never)

      // Wait for PID to resolve
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      // _tryCorrelateUnmatched should be called again after PID resolves
      expect(mockCorrelate).toHaveBeenCalledTimes(1)
      expect(mockCorrelate).toHaveBeenCalledWith(process.pid, expect.any(Array))
    })
  })

  // ─── T5.7 tests ───────────────────────────────────────────────────────────

  // ─── T5.8 tests ───────────────────────────────────────────────────────────

  describe('remote source awareness (T5.8)', () => {
    const extensionUri = { fsPath: '/mock/extension' } as never

    const makeEntry = (overrides?: Partial<WindowEntry>): WindowEntry => ({
      windowId: 'win-2',
      workspaceName: 'other-project',
      socketPath: '/tmp/vscode-claude-2.sock',
      terminals: [{ name: 'bash' }],
      lastHeartbeat: Date.now(),
      ...overrides,
    })

    it('(i) getTerminalInfoForRegistry includes source from session record', async () => {
      const terminal = { name: 'bash', processId: Promise.resolve(42) }
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [terminal]
      const record = makeRecord({
        sessionId: 'codex-sess-1',
        source: 'codex',
        terminalId: 42,
      })
      const provider = new ClaudeTerminalProvider((cb) => cb([record]))
      // Wait for _initTerminalPidMap to resolve processId
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const infos = provider.getTerminalInfoForRegistry()
      expect(infos).toHaveLength(1)
      expect(infos[0]?.session?.source).toBe('codex')
    })

    it('(j) remote entries propagate source through _getRemoteChildren', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const provider = new ClaudeTerminalProvider()
      provider.refreshRemoteTerminals([
        makeEntry({
          terminals: [
            {
              name: 'codex-terminal',
              session: {
                sessionId: 'codex-sess-1',
                status: 'running',
                subtitle: undefined,
                statusLabel: undefined,
                source: 'codex',
              },
            },
          ],
        }),
      ])

      const remoteSection: SectionNode = {
        kind: 'section',
        sectionType: 'remote',
        windowId: 'win-2',
        workspaceName: 'other-project',
      }
      const children = provider.getChildren(remoteSection)
      expect(children).toHaveLength(1)
      const remote = children[0] as RemoteTerminalNode
      expect(remote.session?.source).toBe('codex')
    })
  })

  // ─── T5.11 mixed session tests ───────────────────────────────────────────

  // ─── T6.7 shortcut index tests ─────────────────────────────────────────────

  describe('shortcut index (T6.7)', () => {
    it('2(a) indices are sequential starting from 0', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const records = [
        makeRecord({ sessionId: 's1', status: 'active' }),
        makeRecord({ sessionId: 's2', status: 'running' }),
        makeRecord({ sessionId: 's3', status: 'waiting_for_input' }),
      ]
      const provider = new ClaudeTerminalProvider((cb) => cb(records))
      const children = provider.getChildren(localSection)

      const indices = children.map((child) =>
        provider.getShortcutIndex(child),
      )
      expect(indices).toEqual([0, 1, 2])
    })

    it('2(b) indices recompute after adding/removing sessions', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      let sessionCallback:
        | ((sessions: ReadonlyArray<SessionRecord>) => void)
        | undefined
      const initialRecords = [
        makeRecord({ sessionId: 's1', status: 'active' }),
        makeRecord({ sessionId: 's2', status: 'running' }),
      ]
      const provider = new ClaudeTerminalProvider((cb) => {
        sessionCallback = cb
        cb(initialRecords)
      })

      // Verify initial indices
      const childrenBefore = provider.getChildren(localSection)
      expect(childrenBefore).toHaveLength(2)
      expect(provider.getShortcutIndex(childrenBefore[0]!)).toBe(0)
      expect(provider.getShortcutIndex(childrenBefore[1]!)).toBe(1)

      // Add a third session
      const updatedRecords = [
        ...initialRecords,
        makeRecord({ sessionId: 's3', status: 'active' }),
      ]
      sessionCallback?.(updatedRecords)

      const childrenAfter = provider.getChildren(localSection)
      expect(childrenAfter).toHaveLength(3)
      expect(provider.getShortcutIndex(childrenAfter[2]!)).toBe(2)

      // Remove first session
      sessionCallback?.([
        makeRecord({ sessionId: 's2', status: 'running' }),
        makeRecord({ sessionId: 's3', status: 'active' }),
      ])

      const childrenReduced = provider.getChildren(localSection)
      expect(childrenReduced).toHaveLength(2)
      expect(provider.getShortcutIndex(childrenReduced[0]!)).toBe(0)
      expect(provider.getShortcutIndex(childrenReduced[1]!)).toBe(1)
    })

    it('2(c) getShortcutIndex returns correct index for a given node', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        { name: 'bash' },
      ]
      const records = [
        makeRecord({ sessionId: 's1', status: 'active' }),
      ]
      const provider = new ClaudeTerminalProvider((cb) => cb(records))
      const children = provider.getChildren(localSection)

      // Find the session node and terminal node
      const sessionNode = children.find(
        (node) => node.kind === 'session',
      )
      const terminalNode = children.find(
        (node) => node.kind === 'terminal',
      )

      expect(sessionNode).toBeDefined()
      expect(terminalNode).toBeDefined()

      const sessionIdx = provider.getShortcutIndex(sessionNode!)
      const terminalIdx = provider.getShortcutIndex(terminalNode!)

      // Both should be defined and different
      expect(sessionIdx).toBeDefined()
      expect(terminalIdx).toBeDefined()
      expect(sessionIdx).not.toBe(terminalIdx)
    })

    it('2(d) all non-section node types receive indices', () => {
      vi.mocked(getShowTerminalsFromAllWindows).mockReturnValue(true)
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        { name: 'bash' },
      ]
      const records = [
        makeRecord({ sessionId: 's1', status: 'active' }),
      ]
      const remoteEntry: WindowEntry = {
        windowId: 'win-2',
        workspaceName: 'remote-proj',
        socketPath: '/tmp/test.sock',
        terminals: [{ name: 'zsh' }],
        lastHeartbeat: Date.now(),
      }
      const provider = new ClaudeTerminalProvider((cb) => cb(records))
      provider.refreshRemoteTerminals([remoteEntry])

      // Get local children
      const localChildren = provider.getChildren(localSection)
      const sessionNode = localChildren.find(
        (node) => node.kind === 'session',
      )
      const terminalNode = localChildren.find(
        (node) => node.kind === 'terminal',
      )

      // Get remote children
      const remoteSection: SectionNode = {
        kind: 'section',
        sectionType: 'remote',
        windowId: 'win-2',
        workspaceName: 'remote-proj',
      }
      const remoteChildren = provider.getChildren(remoteSection)
      const remoteTerminalNode = remoteChildren.find(
        (node) => node.kind === 'remoteTerminal',
      )

      expect(sessionNode).toBeDefined()
      expect(terminalNode).toBeDefined()
      expect(remoteTerminalNode).toBeDefined()

      expect(provider.getShortcutIndex(sessionNode!)).toBeDefined()
      expect(
        typeof provider.getShortcutIndex(sessionNode!),
      ).toBe('number')
      expect(provider.getShortcutIndex(terminalNode!)).toBeDefined()
      expect(
        typeof provider.getShortcutIndex(terminalNode!),
      ).toBe('number')
      expect(
        provider.getShortcutIndex(remoteTerminalNode!),
      ).toBeDefined()
      expect(
        typeof provider.getShortcutIndex(remoteTerminalNode!),
      ).toBe('number')
    })

    it('2(e) section nodes do NOT receive indices', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = []
      const records = [
        makeRecord({ sessionId: 's1', status: 'active' }),
      ]
      const provider = new ClaudeTerminalProvider((cb) => cb(records))

      const root = provider.getChildren()
      const sections = root.filter((node) => node.kind === 'section')
      expect(sections.length).toBeGreaterThan(0)

      for (const section of sections) {
        expect(provider.getShortcutIndex(section)).toBeUndefined()
      }
    })

    it('2(f) getChildByIndex returns correct node by flat index', () => {
      ;(vscode.window as unknown as { terminals: unknown[] }).terminals = [
        { name: 'bash' },
        { name: 'zsh' },
      ]
      const records = [
        makeRecord({ sessionId: 's1', status: 'active' }),
      ]
      const provider = new ClaudeTerminalProvider((cb) => cb(records))
      const children = provider.getChildren(localSection)

      // Each child should match getChildByIndex
      for (let idx = 0; idx < children.length; idx++) {
        const node = provider.getChildByIndex(idx)
        expect(node).toBeDefined()
        expect(node?.kind).toBe(children[idx]!.kind)
      }

      // Out of range returns undefined
      expect(provider.getChildByIndex(999)).toBeUndefined()
    })

  })
})
