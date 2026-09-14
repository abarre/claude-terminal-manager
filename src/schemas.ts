import { Effect, ParseResult, Schema } from 'effect'

const Source = Schema.optionalWith(Schema.String, {
  exact: true,
  default: () => 'claude',
})

export const SessionStartEvent = Schema.Struct({
  event: Schema.Literal('session_start'),
  session_id: Schema.String,
  pid: Schema.optionalWith(Schema.Number, { exact: true, default: () => 0 }),
  branch: Schema.optionalWith(Schema.String, { exact: true }),
  cwd: Schema.optionalWith(Schema.String, { exact: true }),
  source: Source,
})

export const UserPromptSubmitEvent = Schema.Struct({
  event: Schema.Literal('user_prompt_submit'),
  session_id: Schema.String,
  prompt: Schema.String,
  source: Source,
})

export const PreToolUseEvent = Schema.Struct({
  event: Schema.Literal('pre_tool_use'),
  session_id: Schema.String,
  tool_name: Schema.String,
  source: Source,
})

/**
 * Claude is blocked on the user: a permission prompt is on screen. Distinct
 * from pre_tool_use, which fires before the permission check and so cannot
 * tell an auto-approved tool from one waiting on a decision.
 */
export const PermissionRequestEvent = Schema.Struct({
  event: Schema.Literal('permission_request'),
  session_id: Schema.String,
  tool_name: Schema.String,
  detail: Schema.optionalWith(Schema.String, { exact: true }),
  source: Source,
})

export const StopEvent = Schema.Struct({
  event: Schema.Literal('stop'),
  session_id: Schema.String,
  stop_reason: Schema.optionalWith(Schema.String, { exact: true }),
  // Still-running background agents/tasks at the end of the turn. Absent on
  // Claude Code < 2.1.198, which is why it is optional rather than defaulted:
  // the state machine falls back to the last count it saw.
  background_tasks: Schema.optionalWith(Schema.Number, { exact: true }),
  source: Source,
})

/**
 * A background agent finished. The only event that refreshes the background
 * count while the main loop sits at the prompt.
 */
export const SubagentStopEvent = Schema.Struct({
  event: Schema.Literal('subagent_stop'),
  session_id: Schema.String,
  background_tasks: Schema.Number,
  source: Source,
})

export const ToolInterruptedEvent = Schema.Struct({
  event: Schema.Literal('tool_interrupted'),
  session_id: Schema.String,
  tool_name: Schema.optionalWith(Schema.String, { exact: true }),
  source: Source,
})

/** An ordinary tool completion — used to retire a granted permission prompt. */
export const ToolCompletedEvent = Schema.Struct({
  event: Schema.Literal('tool_completed'),
  session_id: Schema.String,
  tool_name: Schema.optionalWith(Schema.String, { exact: true }),
  source: Source,
})

export const SessionEndEvent = Schema.Struct({
  event: Schema.Literal('session_end'),
  session_id: Schema.String,
  // Absent when the event comes from the SessionEnd hook; the reaper, which
  // synthesises this event from a dead process, always knows the pid.
  pid: Schema.optionalWith(Schema.Number, { exact: true, default: () => 0 }),
  source: Source,
})

export const HookEvent = Schema.Union(
  SessionStartEvent,
  UserPromptSubmitEvent,
  PreToolUseEvent,
  PermissionRequestEvent,
  StopEvent,
  SubagentStopEvent,
  ToolInterruptedEvent,
  ToolCompletedEvent,
  SessionEndEvent,
)

export type SessionStartEvent = Schema.Schema.Type<typeof SessionStartEvent>
export type UserPromptSubmitEvent = Schema.Schema.Type<
  typeof UserPromptSubmitEvent
>
export type PreToolUseEvent = Schema.Schema.Type<typeof PreToolUseEvent>
export type PermissionRequestEvent = Schema.Schema.Type<
  typeof PermissionRequestEvent
>
export type StopEvent = Schema.Schema.Type<typeof StopEvent>
export type SubagentStopEvent = Schema.Schema.Type<typeof SubagentStopEvent>
export type ToolInterruptedEvent = Schema.Schema.Type<
  typeof ToolInterruptedEvent
>
export type ToolCompletedEvent = Schema.Schema.Type<typeof ToolCompletedEvent>
export type SessionEndEvent = Schema.Schema.Type<typeof SessionEndEvent>
export type HookEvent = Schema.Schema.Type<typeof HookEvent>

const decodeHookEvent = Schema.decodeUnknown(HookEvent)

export const parseHookEvent = (
  input: unknown,
): Effect.Effect<HookEvent, ParseResult.ParseError> => decodeHookEvent(input)

export const parseHookEventFromString = (
  line: string,
): Effect.Effect<HookEvent, ParseResult.ParseError | SyntaxError> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (err) {
    return Effect.fail(err as SyntaxError)
  }
  return decodeHookEvent(parsed)
}
