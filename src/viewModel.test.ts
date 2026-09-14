import { describe, it, expect } from 'vitest'
import {
  buildProjectGroups,
  buildTicketTiers,
  buildViewModel,
  cleanPromptText,
  deriveState,
  resolveShortcut,
  isAttentionEffective,
  projectNameOf,
  splitStatusLabel,
} from './viewModel.js'
import type {
  BuildInput,
  HistoryEntry,
  RemoteSessionInput,
  TicketRecord,
} from './viewModel.js'
import type { SessionRecord } from './stateMachine.js'

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 's1',
  status: 'waiting_for_input',
  pid: 100,
  subtitle: undefined,
  terminalId: undefined,
  customName: undefined,
  slug: undefined,
  cwd: '/home/me/fstrz',
  lastEventAt: 1000,
  statusLabel: undefined,
  needsAttention: false,
  activeBlockingTool: undefined,
  source: 'claude',
  backgroundTasks: 0,
  idleWithBackground: false,
  ...over,
})

const input = (over: Partial<BuildInput> = {}): BuildInput => ({
  sessions: [],
  remote: [],
  history: [],
  tickets: undefined,
  terminals: [],
  workspaceName: undefined,
  workspaceFolder: undefined,
  workspaceBranch: undefined,
  activeTerminalId: undefined,
  storedName: () => undefined,
  shortcutsEnabled: false,
  ...over,
})

describe('projectNameOf', () => {
  it('takes the last path segment', () => {
    expect(projectNameOf('/home/me/fstrz')).toBe('fstrz')
  })

  it('tolerates a trailing slash', () => {
    expect(projectNameOf('/home/me/fstrz/')).toBe('fstrz')
  })

  it('handles a name containing a dash', () => {
    expect(projectNameOf('/home/me/claude-terminal-manager')).toBe(
      'claude-terminal-manager',
    )
  })

  it('returns undefined for no cwd', () => {
    expect(projectNameOf(undefined)).toBeUndefined()
  })
})

describe('splitStatusLabel', () => {
  it('splits a permission label into lead and detail', () => {
    expect(splitStatusLabel('Allow Bash: pnpm vitest run?')).toEqual({
      lead: 'Allow Bash',
      detail: 'pnpm vitest run?',
    })
  })

  it('splits a verbose running label', () => {
    expect(splitStatusLabel('Running: Grep')).toEqual({
      lead: 'Running',
      detail: 'Grep',
    })
  })

  it('leaves a colonless label whole', () => {
    expect(splitStatusLabel('3 background tasks running')).toEqual({
      lead: undefined,
      detail: '3 background tasks running',
    })
  })

  it('does not treat a colon deep in a command as the lead', () => {
    const label =
      'Allow Bash: ssh host "grep -n foo: bar" — a very long command line?'
    expect(splitStatusLabel(label).lead).toBe('Allow Bash')
  })

  it('leaves a label whole when the first colon is far in', () => {
    const label = 'this lead is far too long to be a lead: tail'
    expect(splitStatusLabel(label)).toEqual({ lead: undefined, detail: label })
  })

  it('returns undefined for an empty label', () => {
    expect(splitStatusLabel(undefined)).toEqual({
      lead: undefined,
      detail: undefined,
    })
  })
})

describe('cleanPromptText', () => {
  it('replaces a background-task injection with words', () => {
    // Stored prompts are sliced at 70 chars, so the closing tag is usually gone.
    expect(
      cleanPromptText('<task-notification>\n<task-id>bom58vms-1234</task-id>'),
    ).toBe('Background task finished')
  })

  it('drops a prompt that is only a system reminder', () => {
    expect(cleanPromptText('<system-reminder>do the thing')).toBeUndefined()
  })

  it('keeps the human part of a prompt with an injected block', () => {
    expect(
      cleanPromptText('update the playbook <system-reminder>x</system-reminder> please'),
    ).toBe('update the playbook please')
  })

  it('leaves an ordinary prompt alone', () => {
    expect(cleanPromptText('ok, update the playbook')).toBe(
      'ok, update the playbook',
    )
  })

  it('does not strip angle brackets from real prose', () => {
    expect(cleanPromptText('use a < b in the comparison')).toBe(
      'use a < b in the comparison',
    )
  })

  it('passes through undefined', () => {
    expect(cleanPromptText(undefined)).toBeUndefined()
  })
})

describe('isAttentionEffective', () => {
  it('is false when the record does not need attention', () => {
    expect(isAttentionEffective(record(), 5)).toBe(false)
  })

  it('is true when attention is needed and the terminal is not focused', () => {
    const r = record({ needsAttention: true, terminalId: 7 })
    expect(isAttentionEffective(r, 5)).toBe(true)
  })

  it('is muted once the user focuses the terminal', () => {
    const r = record({ needsAttention: true, terminalId: 5 })
    expect(isAttentionEffective(r, 5)).toBe(false)
  })

  it('survives focus while a permission prompt is still on screen', () => {
    const r = record({
      needsAttention: true,
      terminalId: 5,
      activeBlockingTool: 'Bash',
    })
    expect(isAttentionEffective(r, 5)).toBe(true)
  })
})

describe('deriveState', () => {
  it('maps an inactive record to ended', () => {
    expect(deriveState(record({ status: 'inactive' }), undefined)).toBe('ended')
  })

  it('maps a needs-attention record to attention', () => {
    expect(deriveState(record({ needsAttention: true }), undefined)).toBe(
      'attention',
    )
  })

  it('prefers attention over background work', () => {
    const r = record({
      needsAttention: true,
      idleWithBackground: true,
      backgroundTasks: 3,
      status: 'running',
    })
    expect(deriveState(r, undefined)).toBe('attention')
  })

  it('maps an idle-with-background record to background', () => {
    const r = record({
      status: 'running',
      idleWithBackground: true,
      backgroundTasks: 2,
    })
    expect(deriveState(r, undefined)).toBe('background')
  })

  it('maps a busy main loop to running even with subagents out', () => {
    const r = record({
      status: 'running',
      idleWithBackground: false,
      backgroundTasks: 2,
    })
    expect(deriveState(r, undefined)).toBe('running')
  })

  it('maps a parked record to idle', () => {
    expect(deriveState(record(), undefined)).toBe('idle')
  })
})

describe('buildProjectGroups', () => {
  it('groups sessions by the basename of their cwd', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({ sessionId: 'a', cwd: '/home/me/fstrz' }),
          record({ sessionId: 'b', cwd: '/home/me/engine' }),
        ],
      }),
    )
    expect(groups.map((g) => g.name).sort()).toEqual(['engine', 'fstrz'])
  })

  it('falls back to the workspace name when a session has no cwd', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [record({ cwd: undefined })],
        workspaceName: 'my-workspace',
      }),
    )
    expect(groups[0]!.name).toBe('my-workspace')
  })

  it('orders rows attention, running, background, then idle', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({ sessionId: 'idle' }),
          record({ sessionId: 'run', status: 'running' }),
          record({ sessionId: 'attn', needsAttention: true }),
          record({
            sessionId: 'bg',
            status: 'running',
            idleWithBackground: true,
            backgroundTasks: 1,
          }),
        ],
      }),
    )
    expect(groups[0]!.live.map((s) => s.id)).toEqual([
      'attn',
      'run',
      'bg',
      'idle',
    ])
  })

  it('breaks ties by recency, newest first', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({ sessionId: 'old', lastEventAt: 10 }),
          record({ sessionId: 'new', lastEventAt: 99 }),
        ],
      }),
    )
    expect(groups[0]!.live.map((s) => s.id)).toEqual(['new', 'old'])
  })

  it('puts groups with something waiting on the user first', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({ sessionId: 'a', cwd: '/x/aaa' }),
          record({ sessionId: 'b', cwd: '/x/zzz', needsAttention: true }),
        ],
      }),
    )
    expect(groups.map((g) => g.name)).toEqual(['zzz', 'aaa'])
  })

  it('ranks projects by how much they need you', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({ sessionId: 'i', cwd: '/x/b-idle' }),
          record({ sessionId: 'r', cwd: '/x/c-running', status: 'running' }),
          record({ sessionId: 'a', cwd: '/x/d-attention', needsAttention: true }),
        ],
        history: [{ id: 'h', cwd: '/x/a-history-only', title: 't', endedAt: 1 }],
      }),
    )
    // Alphabetically this is a, b, c, d — activity overrides that entirely.
    expect(groups.map((g) => g.name)).toEqual([
      'd-attention',
      'c-running',
      'b-idle',
      'a-history-only',
    ])
  })

  it('ranks a project with only background work above an idle one', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({ sessionId: 'i', cwd: '/x/aaa' }),
          record({
            sessionId: 'b',
            cwd: '/x/zzz',
            status: 'running',
            idleWithBackground: true,
            backgroundTasks: 2,
          }),
        ],
      }),
    )
    expect(groups.map((g) => g.name)).toEqual(['zzz', 'aaa'])
  })

  it('sorts alphabetically among equally active projects', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({ sessionId: 'z', cwd: '/x/zebra', status: 'running' }),
          record({ sessionId: 'a', cwd: '/x/alpha', status: 'running' }),
        ],
      }),
    )
    expect(groups.map((g) => g.name)).toEqual(['alpha', 'zebra'])
  })

  it('places history in the past bucket, newest first', () => {
    const history: HistoryEntry[] = [
      { id: 'h1', cwd: '/home/me/fstrz', title: 'older', endedAt: 10 },
      { id: 'h2', cwd: '/home/me/fstrz', title: 'newer', endedAt: 50 },
    ]
    const groups = buildProjectGroups(input({ history }))
    expect(groups[0]!.past.map((s) => s.title)).toEqual(['newer', 'older'])
    expect(groups[0]!.past.every((s) => s.state === 'ended')).toBe(true)
    expect(groups[0]!.past.every((s) => !s.live)).toBe(true)
  })

  it('never lists a live session as history as well', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [record({ sessionId: 'dup', cwd: '/home/me/fstrz' })],
        history: [
          { id: 'dup', cwd: '/home/me/fstrz', title: 't', endedAt: 5 },
        ],
      }),
    )
    expect(groups[0]!.live).toHaveLength(1)
    expect(groups[0]!.past).toHaveLength(0)
  })

  it('files history under the same group as live sessions of that project', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [record({ sessionId: 'live', cwd: '/home/me/fstrz' })],
        history: [
          { id: 'past', cwd: '/home/me/fstrz', title: 't', endedAt: 5 },
        ],
      }),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.live).toHaveLength(1)
    expect(groups[0]!.past).toHaveLength(1)
  })

  it('resolves the title as stored name, then slug, then source', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({ sessionId: 'a', slug: 'the-slug' }),
          record({ sessionId: 'b', slug: 'ignored' }),
          record({ sessionId: 'c', source: 'codex' }),
        ],
        storedName: (id) => (id === 'b' ? 'renamed' : undefined),
      }),
    )
    const byId = new Map(groups[0]!.live.map((s) => [s.id, s.title]))
    expect(byId.get('a')).toBe('the-slug')
    expect(byId.get('b')).toBe('renamed')
    expect(byId.get('c')).toBe('Codex')
  })

  it('falls back to the branch rather than a bare "Claude"', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [record({ slug: undefined, customName: 'feat/sc-1-thing' })],
      }),
    )
    expect(groups[0]!.live[0]!.title).toBe('feat/sc-1-thing')
  })

  it('shows the blocking question rather than the stale prompt', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [
          record({
            status: 'running',
            needsAttention: true,
            statusLabel: 'Allow Bash: pnpm vitest run?',
            subtitle: 'an old prompt of mine',
          }),
        ],
      }),
    )
    const view = groups[0]!.live[0]!
    expect(view.lead).toBe('Allow Bash')
    expect(view.detail).toBe('pnpm vitest run?')
  })

  it('falls back to the prompt when nothing is pending', () => {
    const groups = buildProjectGroups(
      input({ sessions: [record({ subtitle: 'what I asked' })] }),
    )
    expect(groups[0]!.live[0]!.detail).toBe('what I asked')
  })

  it('never shows raw harness plumbing as the prompt', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [record({ subtitle: '<task-notification>\n<task-id>bom58' })],
      }),
    )
    expect(groups[0]!.live[0]!.detail).toBe('Background task finished')
  })

  it('carries the per-session branch from customName', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [record({ customName: 'feat/sc-1234-thing' })],
        workspaceBranch: 'master',
      }),
    )
    expect(groups[0]!.live[0]!.branch).toBe('feat/sc-1234-thing')
  })

  it('includes remote sessions from other windows', () => {
    const remote: RemoteSessionInput[] = [
      {
        windowId: 'w2',
        socketPath: '/tmp/s.sock',
        terminalName: 'zsh',
        terminalPid: 4242,
        workspaceName: 'other',
        workspaceFolderPath: '/home/me/other',
        branch: 'main',
        sessionId: 'r1',
        status: 'running',
        subtitle: undefined,
        statusLabel: 'Running: Bash',
        needsAttention: false,
        slug: 'remote-slug',
        source: 'claude',
        cwd: '/home/me/other',
        backgroundTasks: 0,
        lastEventAt: 77,
      },
    ]
    const groups = buildProjectGroups(input({ remote }))
    expect(groups[0]!.name).toBe('other')
    expect(groups[0]!.live[0]!.state).toBe('running')
  })

  it('carries what a remote row needs to activate its window', () => {
    const remote: RemoteSessionInput[] = [
      {
        windowId: 'w2',
        socketPath: '/tmp/s.sock',
        terminalName: 'zsh',
        terminalPid: 4242,
        workspaceName: 'other',
        workspaceFolderPath: '/home/me/other',
        branch: 'main',
        sessionId: 'r1',
        status: 'running',
        subtitle: undefined,
        statusLabel: undefined,
        needsAttention: false,
        slug: undefined,
        source: 'claude',
        cwd: '/home/me/other',
        backgroundTasks: 0,
        lastEventAt: 77,
      },
    ]
    // Without the folder path and pid, the `code -r` activation cannot target
    // the right window and the focus request cannot find the right terminal.
    expect(buildProjectGroups(input({ remote }))[0]!.live[0]!.remote).toEqual({
      windowId: 'w2',
      socketPath: '/tmp/s.sock',
      terminalName: 'zsh',
      workspaceName: 'other',
      workspaceFolderPath: '/home/me/other',
      terminalPid: 4242,
    })
  })
})

describe('plain terminals', () => {
  it('groups terminals with the sessions of the same project', () => {
    const groups = buildProjectGroups(
      input({
        sessions: [record({ cwd: '/home/me/fstrz' })],
        terminals: [{ pid: 42, name: 'zsh', cwd: '/home/me/fstrz' }],
      }),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.terminals.map((t) => t.name)).toEqual(['zsh'])
  })

  it('sorts terminals by name', () => {
    const groups = buildProjectGroups(
      input({
        terminals: [
          { pid: 2, name: 'zsh', cwd: '/x/repo' },
          { pid: 1, name: 'bash', cwd: '/x/repo' },
        ],
      }),
    )
    expect(groups[0]!.terminals.map((t) => t.name)).toEqual(['bash', 'zsh'])
  })

  it('has no terminals when the caller passes none', () => {
    expect(buildProjectGroups(input()).length).toBe(0)
  })
})

describe('shortcuts', () => {
  const twoProjects = () =>
    input({
      shortcutsEnabled: true,
      sessions: [
        record({ sessionId: 'idle-a', cwd: '/x/aaa' }),
        record({ sessionId: 'attn-a', cwd: '/x/aaa', needsAttention: true }),
        record({ sessionId: 'idle-z', cwd: '/x/zzz' }),
      ],
      terminals: [{ pid: 7, name: 'zsh', cwd: '/x/aaa' }],
    })

  it('assigns no shortcuts when the feature is off', () => {
    const vm = buildViewModel(input({ sessions: [record()] }))
    expect(vm.active[0]!.live[0]!.shortcut).toBeUndefined()
  })

  it('numbers rows in render order, not input order', () => {
    const vm = buildViewModel(twoProjects())
    const flat = vm.active.flatMap((g) => [
      ...g.live.map((s) => [s.shortcut, s.id] as const),
      ...g.terminals.map((t) => [t.shortcut, t.name] as const),
    ])
    // aaa sorts first because it holds the attention row, and within it the
    // attention session leads, then the idle one, then the plain terminal.
    expect(flat).toEqual([
      [0, 'attn-a'],
      [1, 'idle-a'],
      [2, 'zsh'],
      [3, 'idle-z'],
    ])
  })

  it('resolves a shortcut back to its session', () => {
    const vm = buildViewModel(twoProjects())
    expect(resolveShortcut(vm, 0)).toEqual({ kind: 'session', id: 'attn-a' })
  })

  it('resolves a shortcut back to a plain terminal', () => {
    const vm = buildViewModel(twoProjects())
    expect(resolveShortcut(vm, 2)).toEqual({ kind: 'terminal', pid: 7 })
  })

  it('returns nothing for an unused number', () => {
    expect(resolveShortcut(buildViewModel(twoProjects()), 9)).toBeUndefined()
  })

  it('stops numbering after ten rows', () => {
    const many = Array.from({ length: 14 }, (_unused, i) =>
      record({ sessionId: `s${i}`, lastEventAt: 1000 - i, cwd: '/x/one' }),
    )
    const vm = buildViewModel(input({ shortcutsEnabled: true, sessions: many }))
    const numbered = vm.active[0]!.live.filter((s) => s.shortcut !== undefined)
    expect(numbered).toHaveLength(10)
    expect(numbered.map((s) => s.shortcut)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('never numbers a finished session', () => {
    const vm = buildViewModel(
      input({
        shortcutsEnabled: true,
        history: [{ id: 'h', cwd: '/x/one', title: 't', endedAt: 5 }],
      }),
    )
    expect(vm.recent[0]!.past[0]!.shortcut).toBeUndefined()
  })
})

describe('splitSections', () => {
  it('puts a project with live work in Active only', () => {
    const vm = buildViewModel(input({ sessions: [record({ cwd: '/x/repo' })] }))
    expect(vm.active.map((g) => g.name)).toEqual(['repo'])
    expect(vm.recent).toEqual([])
  })

  it('puts a project with only history in Recent only', () => {
    const vm = buildViewModel(
      input({ history: [{ id: 'h', cwd: '/x/repo', title: 't', endedAt: 5 }] }),
    )
    expect(vm.active).toEqual([])
    expect(vm.recent.map((g) => g.name)).toEqual(['repo'])
  })

  it('lists a project in both when it has live work and history', () => {
    const vm = buildViewModel(
      input({
        sessions: [record({ sessionId: 'l', cwd: '/x/repo' })],
        history: [{ id: 'h', cwd: '/x/repo', title: 't', endedAt: 5 }],
      }),
    )
    expect(vm.active.map((g) => g.name)).toEqual(['repo'])
    expect(vm.recent.map((g) => g.name)).toEqual(['repo'])
  })

  it('gives each section only the rows that belong to it', () => {
    const vm = buildViewModel(
      input({
        sessions: [record({ sessionId: 'l', cwd: '/x/repo' })],
        history: [{ id: 'h', cwd: '/x/repo', title: 't', endedAt: 5 }],
      }),
    )
    expect(vm.active[0]!.past).toEqual([])
    expect(vm.recent[0]!.live).toEqual([])
    expect(vm.recent[0]!.terminals).toEqual([])
  })

  it('orders Recent by the project touched most recently', () => {
    const vm = buildViewModel(
      input({
        history: [
          { id: 'old', cwd: '/x/stale', title: 'a', endedAt: 10 },
          { id: 'new', cwd: '/x/fresh', title: 'b', endedAt: 99 },
        ],
      }),
    )
    expect(vm.recent.map((g) => g.name)).toEqual(['fresh', 'stale'])
  })

  it('pins this window\u2019s project to the top of Recent', () => {
    const vm = buildViewModel(
      input({
        workspaceFolder: '/x/mine',
        history: [
          { id: 'a', cwd: '/x/other', title: 'a', endedAt: 99 },
          { id: 'b', cwd: '/x/mine', title: 'b', endedAt: 10 },
        ],
      }),
    )
    // /x/other is newer, but the window's own project leads regardless.
    expect(vm.recent.map((g) => g.name)).toEqual(['mine', 'other'])
  })

  it('pins it even when a session ran in a subdirectory', () => {
    const vm = buildViewModel(
      input({
        workspaceFolder: '/x/mine',
        history: [
          { id: 'a', cwd: '/x/other', title: 'a', endedAt: 99 },
          { id: 'b', cwd: '/x/mine/packages/api', title: 'b', endedAt: 10 },
        ],
      }),
    )
    expect(vm.recent[0]!.name).toBe('api')
  })

  it('still orders the rest by recency behind the pinned project', () => {
    const vm = buildViewModel(
      input({
        workspaceFolder: '/x/mine',
        history: [
          { id: 'a', cwd: '/x/old', title: 'a', endedAt: 5 },
          { id: 'b', cwd: '/x/mine', title: 'b', endedAt: 1 },
          { id: 'c', cwd: '/x/new', title: 'c', endedAt: 99 },
        ],
      }),
    )
    expect(vm.recent.map((g) => g.name)).toEqual(['mine', 'new', 'old'])
  })

  it('keeps a terminals-only project in Active', () => {
    const vm = buildViewModel(
      input({ terminals: [{ pid: 1, name: 'zsh', cwd: '/x/repo' }] }),
    )
    expect(vm.active.map((g) => g.name)).toEqual(['repo'])
    expect(vm.recent).toEqual([])
  })

  it('counts attention from the Active section', () => {
    const vm = buildViewModel(
      input({
        sessions: [record({ needsAttention: true, cwd: '/x/repo' })],
        history: [{ id: 'h', cwd: '/x/repo', title: 't', endedAt: 5 }],
      }),
    )
    expect(vm.attentionCount).toBe(1)
  })
})

describe('buildTicketTiers', () => {
  const tickets: TicketRecord[] = [
    {
      id: 'sc-7465',
      state: 'In Development',
      title: 'expose origin TTFB',
      url: 'https://example.test/7465',
      sessions: [
        { id: 'live-1', name: 'from ticket json', project: 'fstrz', endedAt: 1 },
        { id: 'gone-1', name: 'a past session', project: 'fstrz', endedAt: 2 },
      ],
    },
    {
      id: 'sc-7712',
      state: 'Ready for Review',
      title: 'audit engine timings',
      url: undefined,
      sessions: [
        { id: 'gone-2', name: 'another', project: 'engine', endedAt: 3 },
      ],
    },
  ]

  it('returns nothing when no ticket data is configured', () => {
    expect(buildTicketTiers(input())).toEqual([])
  })

  it('groups tickets by workflow state, preserving command order', () => {
    const tiers = buildTicketTiers(input({ tickets }))
    expect(tiers.map((t) => t.state)).toEqual([
      'In Development',
      'Ready for Review',
    ])
  })

  it('overlays a live session onto its ticket row', () => {
    const tiers = buildTicketTiers(
      input({
        tickets,
        sessions: [
          record({
            sessionId: 'live-1',
            status: 'running',
            slug: 'the-live-title',
          }),
        ],
      }),
    )
    const row = tiers[0]!.tickets[0]!.sessions[0]!
    expect(row.state).toBe('running')
    expect(row.live).toBe(true)
    expect(row.title).toBe('the-live-title')
  })

  it('marks sessions with no live counterpart as ended and resumable', () => {
    const tiers = buildTicketTiers(input({ tickets }))
    const row = tiers[0]!.tickets[0]!.sessions[1]!
    expect(row.id).toBe('gone-1')
    expect(row.state).toBe('ended')
    expect(row.live).toBe(false)
    expect(row.title).toBe('a past session')
  })

  it('is not capped by the history window', () => {
    const tiers = buildTicketTiers(input({ tickets }))
    expect(tiers[1]!.tickets[0]!.sessions[0]!.id).toBe('gone-2')
  })
})

describe('buildViewModel', () => {
  it('counts sessions waiting on the user', () => {
    const vm = buildViewModel(
      input({
        sessions: [
          record({ sessionId: 'a', needsAttention: true, cwd: '/x/one' }),
          record({ sessionId: 'b', needsAttention: true, cwd: '/x/two' }),
          record({ sessionId: 'c', cwd: '/x/two' }),
        ],
      }),
    )
    expect(vm.attentionCount).toBe(2)
  })

  it('reports whether the ticket view can be offered', () => {
    expect(buildViewModel(input()).ticketsAvailable).toBe(false)
    expect(buildViewModel(input({ tickets: [] })).ticketsAvailable).toBe(true)
  })
})
