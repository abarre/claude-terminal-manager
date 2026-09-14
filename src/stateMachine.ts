import type { HookEvent, SessionStartEvent } from './schemas.js'

export type SessionStatus =
  | 'active'
  | 'running'
  | 'waiting_for_input'
  | 'inactive'

export interface SessionRecord {
  readonly sessionId: string
  readonly status: SessionStatus
  readonly pid: number
  readonly subtitle: string | undefined
  readonly terminalId: number | undefined
  readonly customName: string | undefined
  readonly slug: string | undefined
  readonly cwd: string | undefined
  readonly lastEventAt: number
  readonly statusLabel: string | undefined
  readonly needsAttention: boolean
  readonly activeBlockingTool: string | undefined
  readonly source: string
  /**
   * Background agents/tasks still running. Kept across turns so a `stop`
   * payload that omits the field (older Claude Code, or a StopFailure) can
   * fall back to the last count we saw instead of faking idleness.
   */
  readonly backgroundTasks: number
  /**
   * The turn is over and the only thing keeping this session `running` is
   * background work. Distinguishes "the main loop is busy" from "the main loop
   * is done but subagents aren't", which is what lets the last `subagent_stop`
   * hand the session back to the user instead of leaving it busy forever.
   */
  readonly idleWithBackground: boolean
}

export const truncateSubtitle = (s: string, len = 70): string =>
  s.length <= len ? s : s.slice(0, len)

const backgroundLabel = (count: number): string =>
  count === 1 ? '1 background task running' : `${count} background tasks running`

export const createSession = (event: SessionStartEvent): SessionRecord => ({
  sessionId: event.session_id,
  status: 'waiting_for_input',
  pid: event.pid,
  subtitle: undefined,
  terminalId: undefined,
  customName: event.branch,
  slug: undefined,
  cwd: event.cwd,
  lastEventAt: Date.now(),
  statusLabel: undefined,
  needsAttention: false,
  activeBlockingTool: undefined,
  source: event.source,
  backgroundTasks: 0,
  idleWithBackground: false,
})

export const createSessionFromEvent = (
  event: HookEvent,
  verboseMode?: boolean,
): SessionRecord => {
  const base: SessionRecord = {
    sessionId: event.session_id,
    status: 'running',
    pid: 0,
    subtitle: undefined,
    terminalId: undefined,
    customName: undefined,
    slug: undefined,
    cwd: undefined,
    lastEventAt: Date.now(),
    statusLabel: undefined,
    needsAttention: false,
    activeBlockingTool: undefined,
    source: event.source,
    backgroundTasks: 0,
    idleWithBackground: false,
  }
  switch (event.event) {
    case 'user_prompt_submit':
      return { ...base, subtitle: truncateSubtitle(event.prompt) }
    case 'pre_tool_use': {
      const isBlocking =
        event.tool_name === 'AskUserQuestion' ||
        event.tool_name === 'ExitPlanMode'
      return {
        ...base,
        statusLabel:
          verboseMode === true ? `Running: ${event.tool_name}` : undefined,
        needsAttention: isBlocking,
        activeBlockingTool: isBlocking ? event.tool_name : undefined,
      }
    }
    case 'permission_request':
      return {
        ...base,
        statusLabel: event.detail ?? `Permission: ${event.tool_name}`,
        needsAttention: true,
        activeBlockingTool: event.tool_name,
      }
    case 'stop': {
      const running = event.background_tasks ?? 0
      return running > 0
        ? {
            ...base,
            statusLabel: backgroundLabel(running),
            backgroundTasks: running,
            idleWithBackground: true,
          }
        : { ...base, status: 'waiting_for_input', needsAttention: true }
    }
    case 'subagent_stop':
      return event.background_tasks > 0
        ? {
            ...base,
            statusLabel: backgroundLabel(event.background_tasks),
            backgroundTasks: event.background_tasks,
          }
        : base
    case 'tool_interrupted':
      return { ...base, status: 'waiting_for_input' }
    case 'session_end':
      return { ...base, status: 'inactive' }
    default:
      return base
  }
}

export const transitionSession = (
  record: SessionRecord,
  event: HookEvent,
  verboseMode?: boolean,
): SessionRecord => {
  const now = Date.now()
  switch (event.event) {
    // A session_start for a record we already hold means the session came back
    // (resume, or a restart reusing the id), so the status has to come back
    // with it — otherwise it stays inactive and the deferred reaper delete
    // removes a live row.
    case 'session_start':
      return {
        ...record,
        status:
          record.status === 'inactive' ? 'waiting_for_input' : record.status,
        pid: event.pid,
        slug: undefined, // reset so the async slug resolver re-reads from JSONL
        ...(event.branch !== undefined ? { customName: event.branch } : {}),
        ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
        source: event.source,
        backgroundTasks: 0, // session boundary — nothing carries over
        idleWithBackground: false,
        lastEventAt: now,
      }

    case 'user_prompt_submit': {
      // idleWithBackground sessions are `running` only because subagents are
      // still going; the user can still type at them, so the prompt has to
      // apply or the subtitle stays stuck on the previous turn.
      if (
        record.status !== 'active' &&
        record.status !== 'waiting_for_input' &&
        !record.idleWithBackground
      ) {
        return record
      }
      return {
        ...record,
        status: 'running',
        subtitle: truncateSubtitle(event.prompt),
        statusLabel: undefined,
        needsAttention: false,
        activeBlockingTool: undefined,
        idleWithBackground: false,
        lastEventAt: now,
      }
    }

    case 'pre_tool_use': {
      if (record.status !== 'running' && record.status !== 'waiting_for_input') {
        return record
      }
      const isAttentionTool =
        event.tool_name === 'AskUserQuestion' ||
        event.tool_name === 'ExitPlanMode'

      // A prompt already on screen outranks a tool merely starting. Claude
      // issues tool calls in parallel, so a Bash beginning says nothing about
      // whether a question is still waiting on an answer — and letting it
      // clear the flag left sessions reading "Running: Bash" with a question
      // sitting unanswered in the terminal. Only the matching tool_completed,
      // the next prompt, an interrupt or the end of the turn retires it.
      if (!isAttentionTool && record.activeBlockingTool !== undefined) {
        return { ...record, status: 'running', lastEventAt: now }
      }

      return {
        ...record,
        status: 'running',
        statusLabel: verboseMode === true
          ? `Running: ${event.tool_name}`
          : record.statusLabel,
        needsAttention: isAttentionTool,
        activeBlockingTool: isAttentionTool ? event.tool_name : undefined,
        idleWithBackground: false, // the main loop is demonstrably awake
        lastEventAt: now,
      }
    }

    // Claude is blocked on a permission decision. activeBlockingTool keeps the
    // indicator lit even while the terminal is focused, and stops a click on
    // the row from dismissing it — the prompt is still on screen either way.
    case 'permission_request':
      return {
        ...record,
        status: 'running',
        statusLabel: event.detail ?? `Permission: ${event.tool_name}`,
        needsAttention: true,
        activeBlockingTool: event.tool_name,
        idleWithBackground: false,
        lastEventAt: now,
      }

    // A tool finished. Only the tool that was actually blocking can retire the
    // prompt: Claude issues tool calls in parallel, so an auto-approved Read
    // completing says nothing about a Bash prompt still on screen. Every other
    // completion is a no-op, which also keeps the per-tool event off the
    // refresh path and stops it wiping the verbose "Running: <tool>" label.
    case 'tool_completed': {
      if (record.status !== 'running') return record
      if (
        record.activeBlockingTool === undefined ||
        event.tool_name !== record.activeBlockingTool
      ) {
        return record
      }
      return {
        ...record,
        statusLabel:
          record.backgroundTasks > 0
            ? backgroundLabel(record.backgroundTasks)
            : undefined,
        needsAttention: false,
        activeBlockingTool: undefined,
        lastEventAt: now,
      }
    }

    // The main loop finished its turn — but background agents and background
    // shell tasks run on independently. Reporting "waiting for input" during
    // those lulls is the false-idle bug, so stay running until a turn ends
    // with nothing left in flight.
    case 'stop': {
      const running = event.background_tasks ?? record.backgroundTasks
      if (running > 0) {
        return {
          ...record,
          status: 'running',
          statusLabel: backgroundLabel(running),
          needsAttention: false,
          activeBlockingTool: undefined,
          backgroundTasks: running,
          idleWithBackground: true,
          lastEventAt: now,
        }
      }
      return {
        ...record,
        status: 'waiting_for_input',
        statusLabel: undefined,
        needsAttention: true,
        activeBlockingTool: undefined,
        backgroundTasks: 0,
        idleWithBackground: false,
        lastEventAt: now,
      }
    }

    case 'subagent_stop': {
      // Fires for internal utility agents too, so it must never wake a session
      // that was already retired or already handed back to the user.
      if (record.status === 'inactive') return record
      if (event.background_tasks > 0) {
        if (record.status === 'waiting_for_input') {
          // Claude is at the prompt and the user has not looked yet — record
          // the count, but do not take the "your turn" indicator away.
          return record.backgroundTasks === event.background_tasks
            ? record
            : { ...record, backgroundTasks: event.background_tasks }
        }
        return {
          ...record,
          status: 'running',
          statusLabel: backgroundLabel(event.background_tasks),
          backgroundTasks: event.background_tasks,
          lastEventAt: now,
        }
      }
      // The last one finished. If the turn was already over and background work
      // was the only reason this session still read as busy, it is now
      // genuinely waiting on the user — this is the event that says so, and
      // nothing else will.
      if (record.idleWithBackground) {
        return {
          ...record,
          status: 'waiting_for_input',
          statusLabel: undefined,
          needsAttention: true,
          backgroundTasks: 0,
          idleWithBackground: false,
          lastEventAt: now,
        }
      }
      // Mid-turn: the main loop is working, so only the count changes.
      return record.backgroundTasks === 0
        ? record
        : { ...record, backgroundTasks: 0 }
    }

    case 'tool_interrupted':
      return {
        ...record,
        status: 'waiting_for_input',
        statusLabel: undefined,
        needsAttention: false,
        activeBlockingTool: undefined,
        idleWithBackground: false,
        lastEventAt: now,
      }

    case 'session_end':
      return {
        ...record,
        status: 'inactive',
        needsAttention: false,
        activeBlockingTool: undefined,
        backgroundTasks: 0,
        idleWithBackground: false,
        lastEventAt: now,
      }

    default: {
      // Exhaustive check — all HookEvent variants handled above.
      // At runtime this is unreachable; kept for defensive safety.
      const _exhaustive: never = event
      void _exhaustive
      return record
    }
  }
}
