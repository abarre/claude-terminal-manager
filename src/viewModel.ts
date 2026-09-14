import type { SessionRecord } from './stateMachine.js'

/**
 * Display state for one row. Collapses `status` and the orthogonal attention /
 * background flags into the single value the panel actually paints.
 *
 * There is deliberately no `interrupted` state: `tool_interrupted` resets a
 * record to `waiting_for_input` and clears every flag, so nothing on
 * `SessionRecord` distinguishes an escaped tool from an ordinary idle session.
 * Adding one means a new field on the state machine, which is its own change.
 */
export type SessionState =
  | 'running'
  | 'attention'
  | 'background'
  | 'idle'
  | 'ended'

export interface SessionView {
  readonly id: string
  readonly title: string
  readonly project: string | undefined
  readonly branch: string | undefined
  readonly state: SessionState
  /** Short emphasised prefix of the status line, e.g. `Allow Bash`. */
  readonly lead: string | undefined
  /** Remainder of the status line, e.g. `pnpm vitest run?`. */
  readonly detail: string | undefined
  /** Epoch ms of the last thing that happened; the webview renders the age. */
  readonly at: number
  /** False for history/ticket rows — a click resumes instead of focusing. */
  readonly live: boolean
  readonly source: string
  readonly backgroundTasks: number
  /** Present when the row belongs to another VS Code window. */
  readonly remote: RemoteRef | undefined
  /** 0-9 when keyboard shortcuts are enabled. */
  readonly shortcut: number | undefined
}

export interface RemoteRef {
  readonly windowId: string
  readonly socketPath: string
  readonly terminalName: string
  readonly workspaceName: string
  /** Needed to activate the owning window via the `code` CLI. */
  readonly workspaceFolderPath: string | undefined
  readonly terminalPid: number | undefined
}

/** A plain terminal with no agent session, shown when the setting allows it. */
export interface TerminalView {
  readonly pid: number | undefined
  readonly name: string
  readonly project: string | undefined
  readonly shortcut: number | undefined
}

export interface ProjectGroup {
  readonly key: string
  readonly name: string
  /** Working directory this project resolves to, used to route a new session. */
  readonly folder: string | undefined
  readonly branch: string | undefined
  readonly live: readonly SessionView[]
  /** Plain terminals in this project, with no agent session attached. */
  readonly terminals: readonly TerminalView[]
  /** Sessions that ended inside the history window, most recent first. */
  readonly past: readonly SessionView[]
}

export interface TicketEntry {
  readonly id: string
  readonly title: string
  readonly url: string | undefined
  readonly sessions: readonly SessionView[]
}

export interface TicketTier {
  readonly state: string
  readonly tickets: readonly TicketEntry[]
}

export interface ViewModel {
  /** Projects holding sessions whose process is still alive. */
  readonly active: readonly ProjectGroup[]
  /** The same projects, holding only sessions that have ended. */
  readonly recent: readonly ProjectGroup[]
  readonly tickets: readonly TicketTier[]
  readonly ticketsAvailable: boolean
  readonly attentionCount: number
}

/** A plain terminal, as the provider sees it. */
export interface TerminalInput {
  readonly pid: number | undefined
  readonly name: string
  readonly cwd: string | undefined
}

/** One finished session recovered from `~/.claude/projects`. */
export interface HistoryEntry {
  readonly id: string
  readonly cwd: string
  readonly title: string | undefined
  readonly endedAt: number
}

/** A ticket as produced by the configured tickets command. */
export interface TicketRecord {
  readonly id: string
  readonly state: string
  readonly title: string
  readonly url: string | undefined
  readonly sessions: readonly TicketSessionRecord[]
}

export interface TicketSessionRecord {
  readonly id: string
  readonly name: string
  readonly project: string | undefined
  readonly endedAt: number
}

/** A session belonging to another VS Code window, flattened from the registry. */
export interface RemoteSessionInput {
  readonly windowId: string
  readonly socketPath: string
  readonly terminalName: string
  readonly terminalPid: number | undefined
  readonly workspaceName: string
  readonly workspaceFolderPath: string | undefined
  readonly branch: string | undefined
  readonly sessionId: string
  readonly status: string
  readonly subtitle: string | undefined
  readonly statusLabel: string | undefined
  readonly needsAttention: boolean
  readonly slug: string | undefined
  readonly source: string
  readonly cwd: string | undefined
  readonly backgroundTasks: number
  readonly lastEventAt: number | undefined
}

export interface BuildInput {
  readonly sessions: readonly SessionRecord[]
  readonly remote: readonly RemoteSessionInput[]
  readonly history: readonly HistoryEntry[]
  readonly tickets: readonly TicketRecord[] | undefined
  readonly workspaceName: string | undefined
  /** This window's own folder, so its project can be pinned in Recent. */
  readonly workspaceFolder: string | undefined
  readonly workspaceBranch: string | undefined
  /** Terminal pid of the focused terminal, so its attention dot can be muted. */
  readonly activeTerminalId: number | undefined
  readonly terminals: readonly TerminalInput[]
  readonly storedName: (sessionId: string) => string | undefined
  /**
   * Assign 0-9 shortcuts across the rows in the order the panel renders them.
   * Deriving them here rather than from a separate tree walk is what keeps
   * ctrl+alt+N pointing at the row the user is actually looking at.
   */
  readonly shortcutsEnabled: boolean
}

const fallbackName = (source: string): string =>
  source === 'codex' ? 'Codex' : 'Claude'

/** `/a/b/my-repo` -> `my-repo`. Tolerates trailing slashes and Windows paths. */
export const projectNameOf = (cwd: string | undefined): string | undefined => {
  if (cwd === undefined) return undefined
  const parts = cwd.split(/[/\\]/).filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : undefined
}

/**
 * Split a status label into an emphasised lead and the rest.
 *
 * The reporter produces `Allow Bash: pnpm vitest run?`, `Running: Grep` and
 * `3 background tasks running`. Splitting on the first colon gives a useful
 * lead for the first two and leaves the third whole. The length guard stops a
 * colon deep inside a shell command from becoming the lead.
 */
export const splitStatusLabel = (
  label: string | undefined,
): { lead: string | undefined; detail: string | undefined } => {
  if (label === undefined || label.length === 0) {
    return { lead: undefined, detail: undefined }
  }
  const idx = label.indexOf(': ')
  if (idx > 0 && idx <= 24) {
    return { lead: label.slice(0, idx), detail: label.slice(idx + 2) }
  }
  return { lead: undefined, detail: label }
}

/**
 * Tags the harness injects into a turn as if the user had typed them. They are
 * plumbing, not something anyone chose to say, so they never belong in the row.
 */
const HARNESS_TAGS = [
  'task-notification',
  'system-reminder',
  'local-command-stdout',
  'command-name',
  'command-message',
  'command-args',
  'function_results',
]

const PAIRED_TAGS = new RegExp(
  `<(${HARNESS_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`,
  'g',
)
const OPENING_TAG = new RegExp(`^\\s*<(${HARNESS_TAGS.join('|')})\\b`)

/**
 * Make a recorded prompt fit to display.
 *
 * The prompt is stored hard-sliced at 70 characters, so an injected block is
 * usually cut off before its closing tag — which is why a prompt that merely
 * *starts* with one is dropped whole rather than patched up. A background task
 * finishing is worth saying in words; the rest is noise with nothing to say.
 */
export const cleanPromptText = (
  text: string | undefined,
): string | undefined => {
  if (text === undefined) return undefined
  if (OPENING_TAG.test(text)) {
    return text.includes('task-notification')
      ? 'Background task finished'
      : undefined
  }
  const stripped = text.replace(PAIRED_TAGS, ' ').replace(/\s+/g, ' ').trim()
  return stripped.length > 0 ? stripped : undefined
}

/**
 * Attention survives the terminal being focused only while a permission prompt
 * is actually on screen — `activeBlockingTool` is what tells us it still is.
 * Mirrors the rule the tree used before the rewrite.
 */
export const isAttentionEffective = (
  record: SessionRecord,
  activeTerminalId: number | undefined,
): boolean => {
  if (!record.needsAttention) return false
  const isActive =
    record.terminalId !== undefined && record.terminalId === activeTerminalId
  return !isActive || record.activeBlockingTool !== undefined
}

export const deriveState = (
  record: SessionRecord,
  activeTerminalId: number | undefined,
): SessionState => {
  if (record.status === 'inactive') return 'ended'
  if (isAttentionEffective(record, activeTerminalId)) return 'attention'
  if (record.idleWithBackground && record.backgroundTasks > 0) return 'background'
  if (record.status === 'running') return 'running'
  return 'idle'
}

const toView = (
  record: SessionRecord,
  input: BuildInput,
): SessionView => {
  const { lead, detail } = splitStatusLabel(record.statusLabel)
  const state = deriveState(record, input.activeTerminalId)
  // The prompt is only worth showing when nothing live is pending: it is the
  // user's own text and goes stale the moment the turn ends.
  const fallbackDetail = detail ?? cleanPromptText(record.subtitle)
  return {
    id: record.sessionId,
    // `slug` carries the resolved display title: an explicit rename, else the
    // title Claude generates, else its random three-word id. The branch is a
    // better stand-in than "Claude" while a young session has none of those.
    title:
      input.storedName(record.sessionId) ??
      record.slug ??
      record.customName ??
      fallbackName(record.source),
    project: projectNameOf(record.cwd) ?? input.workspaceName,
    branch: record.customName ?? input.workspaceBranch,
    state,
    lead,
    detail: fallbackDetail,
    at: record.lastEventAt,
    live: true,
    source: record.source,
    backgroundTasks: record.backgroundTasks,
    remote: undefined,
    shortcut: undefined,
  }
}

const remoteToView = (
  entry: RemoteSessionInput,
  input: BuildInput,
): SessionView => {
  const { lead, detail } = splitStatusLabel(entry.statusLabel)
  const state: SessionState =
    entry.status === 'inactive'
      ? 'ended'
      : entry.needsAttention
        ? 'attention'
        : entry.backgroundTasks > 0 && entry.status !== 'running'
          ? 'background'
          : entry.status === 'running'
            ? 'running'
            : 'idle'
  return {
    id: entry.sessionId,
    title:
      input.storedName(entry.sessionId) ??
      entry.slug ??
      fallbackName(entry.source),
    project: projectNameOf(entry.cwd) ?? entry.workspaceName,
    branch: entry.branch,
    state,
    lead,
    detail: detail ?? cleanPromptText(entry.subtitle),
    at: entry.lastEventAt ?? 0,
    live: true,
    source: entry.source,
    backgroundTasks: entry.backgroundTasks,
    remote: {
      windowId: entry.windowId,
      socketPath: entry.socketPath,
      terminalName: entry.terminalName,
      workspaceName: entry.workspaceName,
      workspaceFolderPath: entry.workspaceFolderPath,
      terminalPid: entry.terminalPid,
    },
    shortcut: undefined,
  }
}

const historyToView = (
  entry: HistoryEntry,
  input: BuildInput,
): SessionView => ({
  id: entry.id,
  title:
    input.storedName(entry.id) ??
    entry.title ??
    (projectNameOf(entry.cwd) ?? 'Claude'),
  project: projectNameOf(entry.cwd),
  branch: undefined,
  state: 'ended',
  lead: undefined,
  detail: undefined,
  at: entry.endedAt,
  live: false,
  source: 'claude',
  backgroundTasks: 0,
  remote: undefined,
  shortcut: undefined,
})

const STATE_ORDER: Record<SessionState, number> = {
  attention: 0,
  running: 1,
  background: 2,
  idle: 3,
  ended: 4,
}

const byStateThenRecency = (a: SessionView, b: SessionView): number => {
  const order = STATE_ORDER[a.state] - STATE_ORDER[b.state]
  return order !== 0 ? order : b.at - a.at
}

export const buildProjectGroups = (
  input: BuildInput,
): readonly ProjectGroup[] => {
  const groups = new Map<
    string,
    {
      name: string
      folder: string | undefined
      branch: string | undefined
      live: SessionView[]
      terminals: TerminalView[]
      past: SessionView[]
    }
  >()

  const groupFor = (
    name: string | undefined,
    branch: string | undefined,
    folder?: string | undefined,
  ): {
    live: SessionView[]
    terminals: TerminalView[]
    past: SessionView[]
    branch: string | undefined
    folder: string | undefined
  } => {
    const key = name ?? 'Unknown'
    let g = groups.get(key)
    if (g === undefined) {
      g = { name: key, folder, branch, live: [], terminals: [], past: [] }
      groups.set(key, g)
    } else {
      if (g.branch === undefined && branch !== undefined) g.branch = branch
      if (g.folder === undefined && folder !== undefined) g.folder = folder
    }
    return g
  }

  const liveIds = new Set<string>()

  for (const record of input.sessions) {
    const view = toView(record, input)
    liveIds.add(view.id)
    groupFor(view.project, view.branch, record.cwd).live.push(view)
  }

  for (const entry of input.remote) {
    const view = remoteToView(entry, input)
    liveIds.add(view.id)
    groupFor(view.project, view.branch, entry.cwd).live.push(view)
  }

  for (const terminal of input.terminals) {
    const project = projectNameOf(terminal.cwd) ?? input.workspaceName
    groupFor(project, undefined, terminal.cwd).terminals.push({
      pid: terminal.pid,
      name: terminal.name,
      project,
      shortcut: undefined,
    })
  }

  for (const entry of input.history) {
    // A session that is running right now must not also appear as history.
    if (liveIds.has(entry.id)) continue
    const view = historyToView(entry, input)
    groupFor(view.project, undefined, entry.cwd).past.push(view)
  }

  const result: ProjectGroup[] = []
  for (const [key, g] of groups) {
    result.push({
      key,
      name: g.name,
      folder: g.folder,
      branch: g.branch,
      live: [...g.live].sort(byStateThenRecency),
      terminals: [...g.terminals].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      ),
      past: [...g.past].sort((a, b) => b.at - a.at),
    })
  }

  return result.sort((a, b) => {
    const rank = groupRank(a) - groupRank(b)
    if (rank !== 0) return rank
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
}

/**
 * How far up a project sorts. Projects you can act on outrank projects that are
 * merely open, and a project holding nothing but finished sessions sinks to the
 * bottom — it is history, not work in progress.
 */
const groupRank = (group: ProjectGroup): number => {
  if (group.live.some((s) => s.state === 'attention')) return 0
  if (group.live.some((s) => s.state === 'running' || s.state === 'background')) {
    return 1
  }
  if (group.live.length > 0) return 2
  if (group.terminals.length > 0) return 3
  return 4
}

export const buildTicketTiers = (
  input: BuildInput,
): readonly TicketTier[] => {
  if (input.tickets === undefined) return []

  const live = new Map<string, SessionView>()
  for (const record of input.sessions) {
    const view = toView(record, input)
    live.set(view.id, view)
  }
  for (const entry of input.remote) {
    const view = remoteToView(entry, input)
    if (!live.has(view.id)) live.set(view.id, view)
  }

  const tiers = new Map<string, TicketEntry[]>()
  for (const ticket of input.tickets) {
    const sessions = ticket.sessions.map((s): SessionView => {
      const liveView = live.get(s.id)
      if (liveView !== undefined) return liveView
      return {
        id: s.id,
        title: input.storedName(s.id) ?? s.name,
        project: s.project,
        branch: undefined,
        state: 'ended',
        lead: undefined,
        detail: undefined,
        at: s.endedAt,
        live: false,
        source: 'claude',
        backgroundTasks: 0,
        remote: undefined,
        shortcut: undefined,
      }
    })
    const list = tiers.get(ticket.state) ?? []
    list.push({
      id: ticket.id,
      title: ticket.title,
      url: ticket.url,
      sessions,
    })
    tiers.set(ticket.state, list)
  }

  // Preserve the order the command emitted its states in.
  return [...tiers.entries()].map(([state, tickets]) => ({ state, tickets }))
}

/**
 * Split one grouping pass into the two sections the panel renders.
 *
 * A project can appear in both: still working in it, and holding sessions from
 * earlier today. Each section carries only the rows that belong to it, so
 * neither has to know about the other's.
 */
/**
 * Whether a group is the project this window has open — by folder when we know
 * it (a session may sit in a subdirectory), else by name.
 */
const isCurrentProject = (
  group: ProjectGroup,
  workspaceFolder: string | undefined,
): boolean => {
  if (workspaceFolder === undefined) return false
  if (group.folder !== undefined) {
    if (group.folder === workspaceFolder) return true
    if (group.folder.startsWith(workspaceFolder + '/')) return true
  }
  return group.name === projectNameOf(workspaceFolder)
}

export const splitSections = (
  groups: readonly ProjectGroup[],
  workspaceFolder?: string | undefined,
): { active: readonly ProjectGroup[]; recent: readonly ProjectGroup[] } => {
  const active: ProjectGroup[] = []
  const recent: ProjectGroup[] = []

  for (const group of groups) {
    if (group.live.length > 0 || group.terminals.length > 0) {
      active.push({ ...group, past: [] })
    }
    if (group.past.length > 0) {
      recent.push({ ...group, live: [], terminals: [], branch: undefined })
    }
  }

  // Recent is a timeline, so the project touched most recently leads — except
  // for the project this window is open on, which is the one you are most
  // likely to want back and so is pinned to the top.
  recent.sort((a, b) => {
    const aCurrent = isCurrentProject(a, workspaceFolder) ? 0 : 1
    const bCurrent = isCurrentProject(b, workspaceFolder) ? 0 : 1
    if (aCurrent !== bCurrent) return aCurrent - bCurrent
    return (b.past[0]?.at ?? 0) - (a.past[0]?.at ?? 0)
  })

  return { active, recent }
}

const MAX_SHORTCUTS = 10

/**
 * Number the first ten rows in render order, so ctrl+alt+N focuses the row the
 * user is actually looking at. Finished sessions are skipped: a shortcut that
 * spawns a terminal is not what the binding means.
 */
const withShortcuts = (
  projects: readonly ProjectGroup[],
): readonly ProjectGroup[] => {
  let next = 0
  return projects.map((group) => ({
    ...group,
    live: group.live.map((session) =>
      next < MAX_SHORTCUTS ? { ...session, shortcut: next++ } : session,
    ),
    terminals: group.terminals.map((terminal) =>
      next < MAX_SHORTCUTS ? { ...terminal, shortcut: next++ } : terminal,
    ),
  }))
}

export const buildViewModel = (input: BuildInput): ViewModel => {
  const { active: grouped, recent } = splitSections(
    buildProjectGroups(input),
    input.workspaceFolder,
  )
  // Only live rows are numbered: a shortcut that spawns a terminal is not what
  // the binding means.
  const active = input.shortcutsEnabled ? withShortcuts(grouped) : grouped
  let attentionCount = 0
  for (const g of active) {
    for (const s of g.live) {
      if (s.state === 'attention') attentionCount += 1
    }
  }
  return {
    active,
    recent,
    tickets: buildTicketTiers(input),
    ticketsAvailable: input.tickets !== undefined,
    attentionCount,
  }
}

/**
 * Resolve a keyboard shortcut back to the thing it points at, using the same
 * model the panel rendered.
 */
export const resolveShortcut = (
  model: ViewModel,
  index: number,
): { kind: 'session'; id: string } | { kind: 'terminal'; pid: number } | undefined => {
  for (const group of model.active) {
    for (const session of group.live) {
      if (session.shortcut === index) return { kind: 'session', id: session.id }
    }
    for (const terminal of group.terminals) {
      if (terminal.shortcut === index && terminal.pid !== undefined) {
        return { kind: 'terminal', pid: terminal.pid }
      }
    }
  }
  return undefined
}
