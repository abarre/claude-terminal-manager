import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDispose, mockRunFork } = vi.hoisted(() => ({
  mockDispose: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  mockRunFork: vi.fn(),
}))

vi.mock('vscode', () => ({
  env: { appName: 'Code' },
  Uri: {
    from: vi.fn((components: { scheme: string; path: string; query?: string }) => ({
      scheme: components.scheme,
      path: components.path,
      query: components.query ?? '',
      toString: () => `${components.scheme}:${components.path}`,
    })),
  },
  window: {
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    registerTreeDataProvider: vi.fn(),
    createTreeView: vi.fn().mockReturnValue({
      onDidChangeSelection: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      dispose: vi.fn(),
    }),
    registerFileDecorationProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    registerWebviewViewProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    createOutputChannel: vi.fn().mockReturnValue({
      appendLine: vi.fn(),
      dispose: vi.fn(),
    }),
    terminals: [] as Array<unknown>,
    onDidOpenTerminal: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidCloseTerminal: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidChangeActiveTerminal: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(true) }),
    onDidChangeConfiguration: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    createFileSystemWatcher: vi.fn().mockReturnValue({
      onDidChange: vi.fn(),
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    }),
  },
  RelativePattern: class {
    constructor(
      public base: unknown,
      public pattern: string,
    ) {}
  },
  commands: {
    registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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
    tooltip: unknown = undefined
    accessibilityInformation: unknown = undefined
    command: unknown = undefined
    resourceUri: unknown = undefined
    constructor(label: string, collapsibleState?: number) {
      this.label = label
      this.collapsibleState = collapsibleState
    }
  },
  ThemeIcon: class {
    id: string
    constructor(id: string) {
      this.id = id
    }
  },
  MarkdownString: class {
    value: string
    constructor(value: string) {
      this.value = value
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  chmodSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  readFileSync: vi.fn().mockReturnValue('{}'),
}))

vi.mock('effect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('effect')>()
  return {
    ...actual,
    ManagedRuntime: {
      make: vi.fn().mockReturnValue({
        runFork: mockRunFork,
        runPromise: vi.fn().mockResolvedValue(undefined),
        dispose: mockDispose,
      }),
    },
  }
})

vi.mock('./settings.js', () => ({
  getShowNonClaudeTerminals: vi.fn().mockReturnValue(true),
  getNotificationsEnabled: vi.fn().mockReturnValue(true),
  getVerboseToolNames: vi.fn().mockReturnValue(false),
  getShowTerminalsFromAllWindows: vi.fn().mockReturnValue(false),
}))

import * as extension from './extension.js'
import * as vscode from 'vscode'
import { ClaudeTerminalProvider } from './treeProvider.js'
import type { SessionNode, TerminalNode } from './treeProvider.js'
import type { SessionRecord } from './stateMachine.js'

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
  ...overrides,
})

const makeWorkspaceState = () => ({
  get: vi.fn<(key: string) => string | undefined>().mockImplementation((key: string) =>
    key === 'ctm:socketId' ? 'test-socket-id' : undefined,
  ),
  update: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  keys: vi.fn<() => readonly string[]>().mockReturnValue([]),
})

const makeContext = (storageUriPath = '/storage') => {
  const workspaceState = makeWorkspaceState()
  return {
    globalStorageUri: { fsPath: storageUriPath },
    extensionUri: { fsPath: '/extension' },
    subscriptions: [] as Array<{ dispose: () => unknown }>,
    environmentVariableCollection: {
      prepend: vi.fn(),
      replace: vi.fn(),
      description: undefined as string | undefined,
    },
    workspaceState,
  }
}

/** Extract the handler for a specific command from registerCommand mock calls */
const getCapturedHandler = <T = SessionNode>(commandId: string) => {
  const calls = vi.mocked(vscode.commands.registerCommand).mock.calls
  const match = calls.find(([cmd]) => cmd === commandId)
  expect(match).toBeDefined()
  return match![1] as (node: T) => Promise<void>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDispose.mockResolvedValue(undefined)
  vi.mocked(vscode.window.onDidOpenTerminal).mockReturnValue({
    dispose: vi.fn(),
  } as never)
  vi.mocked(vscode.window.onDidCloseTerminal).mockReturnValue({
    dispose: vi.fn(),
  } as never)
  vi.mocked(vscode.commands.registerCommand).mockReturnValue({
    dispose: vi.fn(),
  } as never)
})

/**
 * The panel owns the provider now, so reach it through the registered webview
 * view provider rather than through a tree view that no longer exists.
 */
const capturedProvider = (): ClaudeTerminalProvider => {
  const panel = vi.mocked(vscode.window.registerWebviewViewProvider).mock
    .calls[0]?.[1] as unknown as { _provider: ClaudeTerminalProvider }
  return panel._provider
}

describe('renameSession command handler', () => {
  it('(a) updates workspaceState with correct key and value', async () => {
    const ctx = makeContext()
    extension.activate(ctx as never)

    const handler = getCapturedHandler('claudeTerminalManager.renameSession')
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('My New Name')

    const record = makeRecord({ sessionId: 'abc12345def6' })
    const node: SessionNode = { kind: 'session', record, terminal: undefined }

    await handler(node)

    expect(ctx.workspaceState.update).toHaveBeenCalledWith(
      'session:name:abc12345def6',
      'My New Name',
    )
  })

  it('(c) showInputBox is called with current stored name as value', async () => {
    const ctx = makeContext()
    // Pre-populate workspaceState with existing name
    ctx.workspaceState.get.mockImplementation((key: string) => {
      if (key === 'ctm:socketId') return 'test-socket-id'
      if (key === 'ctm:sessions') return []
      return 'Previous Name'
    })
    extension.activate(ctx as never)

    const handler = getCapturedHandler('claudeTerminalManager.renameSession')
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('New Name')

    const record = makeRecord({ sessionId: 'abc12345def6' })
    const node: SessionNode = { kind: 'session', record, terminal: undefined }

    await handler(node)

    expect(vscode.window.showInputBox).toHaveBeenCalledWith({
      prompt: 'Enter session name',
      value: 'Previous Name',
    })
  })

  it('(c2) showInputBox shows customName when no stored name exists', async () => {
    const ctx = makeContext()
    ctx.workspaceState.get.mockReturnValue(undefined)
    extension.activate(ctx as never)

    const handler = getCapturedHandler('claudeTerminalManager.renameSession')
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('New Name')

    const record = makeRecord({
      sessionId: 'abc12345def6',
      customName: 'My Custom Session',
    })
    const node: SessionNode = { kind: 'session', record, terminal: undefined }

    await handler(node)

    expect(vscode.window.showInputBox).toHaveBeenCalledWith({
      prompt: 'Enter session name',
      value: 'My Custom Session',
    })
  })

  it('(c3) showInputBox shows sessionId prefix as default when no name is set', async () => {
    const ctx = makeContext()
    ctx.workspaceState.get.mockReturnValue(undefined)
    extension.activate(ctx as never)

    const handler = getCapturedHandler('claudeTerminalManager.renameSession')
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('New Name')

    const record = makeRecord({
      sessionId: 'abc12345def6',
      customName: undefined,
    })
    const node: SessionNode = { kind: 'session', record, terminal: undefined }

    await handler(node)

    expect(vscode.window.showInputBox).toHaveBeenCalledWith({
      prompt: 'Enter session name',
      value: 'Claude',
    })
  })

  it('(d) rename fires tree refresh via provider.refresh()', async () => {
    const ctx = makeContext()
    extension.activate(ctx as never)

    const provider = capturedProvider()

    // Access the emitter's fire mock and reset call count
    const emitter = (
      provider as unknown as { _changeEmitter: { fire: ReturnType<typeof vi.fn> } }
    )._changeEmitter
    emitter.fire.mockClear()

    const handler = getCapturedHandler('claudeTerminalManager.renameSession')
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('New Name')

    const record = makeRecord({ sessionId: 'abc12345def6' })
    const node: SessionNode = { kind: 'session', record, terminal: undefined }

    await handler(node)

    expect(emitter.fire).toHaveBeenCalled()
  })

  it('does not update workspaceState when user cancels (undefined)', async () => {
    const ctx = makeContext()
    extension.activate(ctx as never)

    const handler = getCapturedHandler('claudeTerminalManager.renameSession')
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined) // user pressed Escape

    const record = makeRecord({ sessionId: 'abc12345def6' })
    const node: SessionNode = { kind: 'session', record, terminal: undefined }

    await handler(node)

    expect(ctx.workspaceState.update).not.toHaveBeenCalled()
  })

  it('does not fire refresh when user cancels (undefined)', async () => {
    const ctx = makeContext()
    extension.activate(ctx as never)

    const provider = capturedProvider()

    const emitter = (
      provider as unknown as { _changeEmitter: { fire: ReturnType<typeof vi.fn> } }
    )._changeEmitter
    emitter.fire.mockClear()

    const handler = getCapturedHandler('claudeTerminalManager.renameSession')
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined)

    const record = makeRecord({ sessionId: 'abc12345def6' })
    const node: SessionNode = { kind: 'session', record, terminal: undefined }

    await handler(node)

    expect(emitter.fire).not.toHaveBeenCalled()
  })
})

