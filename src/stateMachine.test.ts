import { describe, expect, it } from 'vitest'
import type {
  HookEvent,
  SessionStartEvent,
  StopEvent,
  UserPromptSubmitEvent,
} from './schemas.js'
import {
  createSession,
  createSessionFromEvent,
  transitionSession,
  truncateSubtitle,
} from './stateMachine.js'

const makeStart = (
  session_id = 'test-session',
  pid = 42,
  source = 'claude',
): SessionStartEvent => ({ event: 'session_start', session_id, pid, source })

describe('truncateSubtitle', () => {
  it('returns string unchanged when shorter than 70 chars', () => {
    const s = 'hello world'
    expect(truncateSubtitle(s)).toBe(s)
  })

  it('returns string unchanged when exactly 70 chars', () => {
    const s = 'a'.repeat(70)
    expect(truncateSubtitle(s)).toBe(s)
  })

  it('truncates to 70 chars when longer', () => {
    const s = 'a'.repeat(80)
    expect(truncateSubtitle(s)).toBe('a'.repeat(70))
    expect(truncateSubtitle(s).length).toBe(70)
  })

  it('respects a custom len parameter', () => {
    expect(truncateSubtitle('hello world', 5)).toBe('hello')
  })
})

describe('createSession', () => {
  it('returns correct initial record', () => {
    const record = createSession(makeStart('abc', 99))
    expect(record.sessionId).toBe('abc')
    expect(record.pid).toBe(99)
    expect(record.status).toBe('waiting_for_input')
    expect(record.subtitle).toBeUndefined()
    expect(record.terminalId).toBeUndefined()
    expect(record.customName).toBeUndefined()
    expect(record.statusLabel).toBeUndefined()
    expect(record.needsAttention).toBe(false)
    expect(typeof record.lastEventAt).toBe('number')
  })

  it('sets customName from branch when provided', () => {
    const record = createSession({
      event: 'session_start',
      session_id: 's1',
      pid: 1,
      branch: 'feature/my-branch',
      source: 'claude',
    })
    expect(record.customName).toBe('feature/my-branch')
  })
})

describe('transitionSession', () => {
  describe('SessionStart (session_start)', () => {
    it('updates pid and timestamp on an existing session', () => {
      const r = createSession(makeStart('s1', 1))
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 2,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.pid).toBe(2)
      expect(result.status).toBe('waiting_for_input')
      expect(result.lastEventAt).toBeGreaterThanOrEqual(r.lastEventAt)
    })

    it('preserves other fields on session restart', () => {
      const r = { ...createSession(makeStart('s1', 1)), subtitle: 'hello' }
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 99,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.subtitle).toBe('hello')
    })

    it('resets slug on session_start so it can be re-resolved', () => {
      const r = { ...createSession(makeStart('s1', 1)), slug: 'old-slug' }
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 2,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.slug).toBeUndefined()
    })

    it('sets customName from branch on session_start', () => {
      const r = createSession(makeStart('s1', 1))
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 2,
        branch: 'fix/login-bug',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.customName).toBe('fix/login-bug')
    })

    it('preserves customName when branch is not provided', () => {
      const r = { ...createSession(makeStart('s1', 1)), customName: 'my-branch' }
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 2,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.customName).toBe('my-branch')
    })
  })

  describe('UserPromptSubmit (user_prompt_submit)', () => {
    it('transitions from active to running and captures subtitle', () => {
      const r = { ...createSession(makeStart()), status: 'active' as const }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'do something',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.status).toBe('running')
      expect(result.subtitle).toBe('do something')
      expect(result.statusLabel).toBeUndefined()
      expect(result.needsAttention).toBe(false)
    })

    it('transitions from waiting_for_input to running', () => {
      const r = { ...createSession(makeStart()), status: 'waiting_for_input' as const }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'next prompt',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.status).toBe('running')
    })

    it('updates subtitle on second UserPromptSubmit', () => {
      const r = createSession(makeStart())
      const first: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'first prompt',
        source: 'claude',
      }
      const afterFirst = transitionSession(r, first)
      // Simulate stop → waiting_for_input → second prompt
      const stopped = transitionSession(afterFirst, {
        event: 'stop',
        session_id: 'test-session',
        source: 'claude',
      })
      const second: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'second prompt',
        source: 'claude',
      }
      const afterSecond = transitionSession(stopped, second)
      expect(afterSecond.subtitle).toBe('second prompt')
    })

    it('is a no-op when status is running', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'ignored',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result).toBe(r)
    })

    it('is a no-op when status is inactive', () => {
      const r = { ...createSession(makeStart()), status: 'inactive' as const }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'ignored',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result).toBe(r)
    })

    it('truncates prompt to 70 chars for subtitle', () => {
      const r = createSession(makeStart())
      const longPrompt = 'x'.repeat(100)
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: longPrompt,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.subtitle).toBe('x'.repeat(70))
    })

    it('clears statusLabel when transitioning to running', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'waiting_for_input' as const,
        statusLabel: 'Running: Bash',
      }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'go',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.statusLabel).toBeUndefined()
    })
  })

  describe('PreToolUse (pre_tool_use)', () => {
    it('stays running; sets statusLabel when verboseMode=true', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.status).toBe('running')
      expect(result.statusLabel).toBe('Running: Bash')
    })

    it('does not set statusLabel when verboseMode=false', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, false)
      expect(result.statusLabel).toBeUndefined()
    })

    it('does not set statusLabel when verboseMode is omitted', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.statusLabel).toBeUndefined()
    })

    it('is a no-op when active', () => {
      const r = { ...createSession(makeStart()), status: 'active' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result).toBe(r)
    })

    it('transitions from waiting_for_input to running', () => {
      const r = { ...createSession(makeStart()), status: 'waiting_for_input' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.status).toBe('running')
      expect(result.statusLabel).toBe('Running: Bash')
    })

    it('is a no-op when inactive', () => {
      const r = { ...createSession(makeStart()), status: 'inactive' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result).toBe(r)
    })

    it('sets needsAttention=true when tool is AskUserQuestion', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'AskUserQuestion',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.status).toBe('running')
      expect(result.statusLabel).toBe('Running: AskUserQuestion')
      expect(result.needsAttention).toBe(true)
    })

    it('sets needsAttention=true when tool is ExitPlanMode', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'ExitPlanMode',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.status).toBe('running')
      expect(result.needsAttention).toBe(true)
    })

    it('clears needsAttention when tool is not AskUserQuestion', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        needsAttention: true,
      }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.needsAttention).toBe(false)
    })
  })

  describe('Stop (stop)', () => {
    it('transitions to waiting_for_input and clears statusLabel', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        statusLabel: 'Running: Bash',
      }
      const event: HookEvent = {
        event: 'stop',
        session_id: 'test-session',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.status).toBe('waiting_for_input')
      expect(result.statusLabel).toBeUndefined()
      expect(result.needsAttention).toBe(true)
    })

    it('transitions to waiting_for_input from active', () => {
      const r = createSession(makeStart())
      const event: HookEvent = { event: 'stop', session_id: 'test-session', source: 'claude' }
      const result = transitionSession(r, event)
      expect(result.status).toBe('waiting_for_input')
      expect(result.needsAttention).toBe(true)
    })
  })

  describe('ToolInterrupted (tool_interrupted)', () => {
    it('moves to waiting without requesting attention and clears tool state', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        statusLabel: 'Running: Bash',
        needsAttention: true,
        activeBlockingTool: 'Bash',
      }
      const event: HookEvent = {
        event: 'tool_interrupted',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.status).toBe('waiting_for_input')
      expect(result.statusLabel).toBeUndefined()
      expect(result.needsAttention).toBe(false)
      expect(result.activeBlockingTool).toBeUndefined()
    })
  })

  describe('SessionEnd (session_end)', () => {
    it('transitions to inactive from any status', () => {
      const statuses = [
        'active',
        'running',
        'waiting_for_input',
      ] as const
      for (const status of statuses) {
        const r = { ...createSession(makeStart()), status }
        const event: HookEvent = {
          event: 'session_end',
          session_id: 'test-session',
          pid: 42,
          source: 'claude',
        }
        const result = transitionSession(r, event)
        expect(result.status).toBe('inactive')
        expect(result.needsAttention).toBe(false)
      }
    })
  })

  describe('createSessionFromEvent', () => {
    it('user_prompt_submit creates running session with subtitle', () => {
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 's1',
        prompt: 'do something',
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.sessionId).toBe('s1')
      expect(record.status).toBe('running')
      expect(record.pid).toBe(0)
      expect(record.subtitle).toBe('do something')
      expect(record.needsAttention).toBe(false)
    })

    it('pre_tool_use creates running session with statusLabel when verbose', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'Bash',
        source: 'claude',
      }
      const record = createSessionFromEvent(event, true)
      expect(record.status).toBe('running')
      expect(record.statusLabel).toBe('Running: Bash')
    })

    it('pre_tool_use creates running session without statusLabel when not verbose', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'Bash',
        source: 'claude',
      }
      const record = createSessionFromEvent(event, false)
      expect(record.status).toBe('running')
      expect(record.statusLabel).toBeUndefined()
    })

    it('pre_tool_use with AskUserQuestion creates session with needsAttention=true', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'AskUserQuestion',
        source: 'claude',
      }
      const record = createSessionFromEvent(event, true)
      expect(record.status).toBe('running')
      expect(record.statusLabel).toBe('Running: AskUserQuestion')
      expect(record.needsAttention).toBe(true)
    })

    it('stop creates session with waiting_for_input and needsAttention=true', () => {
      const event: HookEvent = { event: 'stop', session_id: 's1', source: 'claude' }
      const record = createSessionFromEvent(event)
      expect(record.status).toBe('waiting_for_input')
      expect(record.needsAttention).toBe(true)
    })

    it('session_end creates session with inactive', () => {
      const event: HookEvent = {
        event: 'session_end',
        session_id: 's1',
        pid: 42,
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.status).toBe('inactive')
    })

    it('session_start creates session with running (default)', () => {
      const event: HookEvent = {
        event: 'session_start',
        session_id: 'f7d3b195-c4e8-41a2-b6f9-8d2e5a7c3b10',
        pid: 42,
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.sessionId).toBe('f7d3b195-c4e8-41a2-b6f9-8d2e5a7c3b10')
      expect(record.status).toBe('running')
      expect(record.pid).toBe(0) // base pid, not from event
    })
  })

  describe('activeBlockingTool lifecycle', () => {
    it('createSession sets activeBlockingTool to undefined', () => {
      const record = createSession(makeStart())
      expect(record.activeBlockingTool).toBeUndefined()
    })

    it('pre_tool_use(AskUserQuestion) sets activeBlockingTool', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'AskUserQuestion',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBe('AskUserQuestion')
    })

    it('pre_tool_use(ExitPlanMode) sets activeBlockingTool', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'ExitPlanMode',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBe('ExitPlanMode')
    })

    // Previously this asserted the opposite. Clearing here was wrong: Claude
    // issues tool calls in parallel, so a Bash starting says nothing about
    // whether the question on screen has been answered, and clearing left the
    // row reading "Running: Bash" with the prompt still waiting.
    it('pre_tool_use(Bash) leaves a standing prompt blocking', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        activeBlockingTool: 'AskUserQuestion' as string | undefined,
      }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBe('AskUserQuestion')
    })

    it('user_prompt_submit clears activeBlockingTool', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'waiting_for_input' as const,
        activeBlockingTool: 'AskUserQuestion' as string | undefined,
      }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'answer',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBeUndefined()
    })

    it('stop clears activeBlockingTool', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        activeBlockingTool: 'ExitPlanMode' as string | undefined,
      }
      const event: HookEvent = {
        event: 'stop',
        session_id: 'test-session',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBeUndefined()
    })

    it('session_end clears activeBlockingTool', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        activeBlockingTool: 'AskUserQuestion' as string | undefined,
      }
      const event: HookEvent = {
        event: 'session_end',
        session_id: 'test-session',
        pid: 42,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBeUndefined()
    })

    it('session_start preserves existing fields (activeBlockingTool unchanged)', () => {
      const r = {
        ...createSession(makeStart()),
        activeBlockingTool: 'AskUserQuestion' as string | undefined,
      }
      const event: HookEvent = {
        event: 'session_start',
        session_id: 'test-session',
        pid: 99,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBe('AskUserQuestion')
    })

    it('createSessionFromEvent sets activeBlockingTool for AskUserQuestion', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'AskUserQuestion',
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.activeBlockingTool).toBe('AskUserQuestion')
    })

    it('createSessionFromEvent does not set activeBlockingTool for Bash', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'Bash',
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.activeBlockingTool).toBeUndefined()
    })

    it('createSessionFromEvent sets activeBlockingTool=undefined for stop', () => {
      const event: HookEvent = { event: 'stop', session_id: 's1', source: 'claude' }
      const record = createSessionFromEvent(event)
      expect(record.activeBlockingTool).toBeUndefined()
    })
  })

  describe('statusLabel lifecycle', () => {
    it('statusLabel cleared on Stop after being set', () => {
      const base = createSession(makeStart())
      const running = transitionSession(base, {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'do work',
        source: 'claude',
      })
      const withLabel = transitionSession(
        running,
        { event: 'pre_tool_use', session_id: 'test-session', tool_name: 'Bash', source: 'claude' },
        true,
      )
      expect(withLabel.statusLabel).toBe('Running: Bash')
      const stopped = transitionSession(withLabel, {
        event: 'stop',
        session_id: 'test-session',
        source: 'claude',
      })
      expect(stopped.statusLabel).toBeUndefined()
    })
  })
})

describe('source field (T5.2)', () => {
  it('(a) createSession sets source from event', () => {
    const session = createSession({
      event: 'session_start',
      session_id: 'abc',
      pid: 1,
      source: 'codex',
    } as SessionStartEvent)
    expect(session.source).toBe('codex')
  })

  it('(b) createSession defaults source to claude when event has default', () => {
    const session = createSession({
      event: 'session_start',
      session_id: 'abc',
      pid: 1,
      source: 'claude',
    } as SessionStartEvent)
    expect(session.source).toBe('claude')
  })

  it('(c) createSessionFromEvent sets source from event', () => {
    const session = createSessionFromEvent({
      event: 'stop',
      session_id: 'abc',
      source: 'codex',
    } as StopEvent)
    expect(session.source).toBe('codex')
  })

  it('(d) transitionSession preserves source through transitions', () => {
    const initial = createSession({
      event: 'session_start',
      session_id: 'abc',
      pid: 1,
      source: 'codex',
    } as SessionStartEvent)
    const after = transitionSession(initial, {
      event: 'user_prompt_submit',
      session_id: 'abc',
      prompt: 'hi',
      source: 'codex',
    } as UserPromptSubmitEvent)
    expect(after.source).toBe('codex')
  })

  it('(e) transitionSession on session_start updates source', () => {
    const initial = createSession({
      event: 'session_start',
      session_id: 'abc',
      pid: 1,
      source: 'claude',
    } as SessionStartEvent)
    const after = transitionSession(initial, {
      event: 'session_start',
      session_id: 'abc',
      pid: 2,
      source: 'codex',
    } as SessionStartEvent)
    expect(after.source).toBe('codex')
  })

  it('(f) createSessionFromEvent for each event type carries source', () => {
    const events: HookEvent[] = [
      { event: 'user_prompt_submit', session_id: 'x', prompt: 'hi', source: 'codex' },
      { event: 'pre_tool_use', session_id: 'x', tool_name: 'Bash', source: 'codex' },
      { event: 'stop', session_id: 'x', source: 'codex' },
      { event: 'session_end', session_id: 'x', pid: 1, source: 'codex' },
    ]
    for (const evt of events) {
      const session = createSessionFromEvent(evt)
      expect(session.source).toBe('codex')
    }
  })

  it('(g) source is preserved through stop transition', () => {
    const initial = createSession(makeStart('s1', 1, 'codex'))
    const stopped = transitionSession(initial, {
      event: 'stop',
      session_id: 's1',
      source: 'codex',
    } as StopEvent)
    expect(stopped.source).toBe('codex')
  })

  it('(h) source is preserved through session_end transition', () => {
    const initial = createSession(makeStart('s1', 1, 'codex'))
    const ended = transitionSession(initial, {
      event: 'session_end',
      session_id: 's1',
      pid: 1,
      source: 'codex',
    } as HookEvent)
    expect(ended.source).toBe('codex')
  })
})

describe('permission_request', () => {
  const blocked = () =>
    transitionSession(createSession(makeStart()), {
      event: 'permission_request',
      session_id: 'test-session',
      tool_name: 'Bash',
      detail: 'Allow Bash: rm -rf build?',
      source: 'claude',
    })

  it('flags attention and records the blocking tool', () => {
    const record = blocked()
    expect(record.status).toBe('running')
    expect(record.needsAttention).toBe(true)
    expect(record.activeBlockingTool).toBe('Bash')
    expect(record.statusLabel).toBe('Allow Bash: rm -rf build?')
  })

  it('falls back to the tool name when no detail is supplied', () => {
    const record = transitionSession(createSession(makeStart()), {
      event: 'permission_request',
      session_id: 'test-session',
      tool_name: 'Write',
      source: 'claude',
    })
    expect(record.statusLabel).toBe('Permission: Write')
  })

  it('is retired by the tool actually running', () => {
    const record = transitionSession(blocked(), {
      event: 'tool_completed',
      session_id: 'test-session',
      tool_name: 'Bash',
      source: 'claude',
    })
    expect(record.needsAttention).toBe(false)
    expect(record.activeBlockingTool).toBeUndefined()
    expect(record.statusLabel).toBeUndefined()
    expect(record.status).toBe('running')
  })

  it('is not retired by an unrelated tool finishing in the same block', () => {
    // Parallel tool calls: an auto-approved Read completing says nothing
    // about a Bash permission prompt still on screen.
    const record = transitionSession(blocked(), {
      event: 'tool_completed',
      session_id: 'test-session',
      tool_name: 'Read',
      source: 'claude',
    })
    expect(record.needsAttention).toBe(true)
    expect(record.activeBlockingTool).toBe('Bash')
  })

  it('keeps the background label when the granted tool finishes', () => {
    const blockedWithWork = { ...blocked(), backgroundTasks: 2 }
    const record = transitionSession(blockedWithWork, {
      event: 'tool_completed',
      session_id: 'test-session',
      tool_name: 'Bash',
      source: 'claude',
    })
    expect(record.statusLabel).toBe('2 background tasks running')
  })

  it('creates a blocked session when the start event was missed', () => {
    const record = createSessionFromEvent({
      event: 'permission_request',
      session_id: 'orphan',
      tool_name: 'Edit',
      source: 'claude',
    })
    expect(record.needsAttention).toBe(true)
    expect(record.activeBlockingTool).toBe('Edit')
  })
})

describe('background task gating', () => {
  const running = () =>
    transitionSession(createSession(makeStart()), {
      event: 'user_prompt_submit',
      session_id: 'test-session',
      prompt: 'go',
      source: 'claude',
    })

  const stopWith = (background_tasks?: number) => {
    const event: HookEvent =
      background_tasks === undefined
        ? { event: 'stop', session_id: 'test-session', source: 'claude' }
        : {
            event: 'stop',
            session_id: 'test-session',
            background_tasks,
            source: 'claude',
          }
    return transitionSession(running(), event)
  }

  it('stays running when the turn ends with background work in flight', () => {
    const record = stopWith(2)
    expect(record.status).toBe('running')
    expect(record.needsAttention).toBe(false)
    expect(record.statusLabel).toBe('2 background tasks running')
    expect(record.backgroundTasks).toBe(2)
  })

  it('uses the singular label for a single background task', () => {
    expect(stopWith(1).statusLabel).toBe('1 background task running')
  })

  it('goes to waiting_for_input when nothing is left running', () => {
    const record = stopWith(0)
    expect(record.status).toBe('waiting_for_input')
    expect(record.needsAttention).toBe(true)
    expect(record.backgroundTasks).toBe(0)
  })

  it('goes to waiting_for_input on a payload with no background_tasks field', () => {
    const record = stopWith(undefined)
    expect(record.status).toBe('waiting_for_input')
    expect(record.needsAttention).toBe(true)
  })

  it('falls back to the last known count when the field is absent', () => {
    // A StopFailure right after a Stop that reported work in flight: the
    // failure payload carries no count, and reading that as zero would fake
    // idleness while the background agents are still going.
    const busy = stopWith(3)
    const record = transitionSession(busy, {
      event: 'stop',
      session_id: 'test-session',
      source: 'claude',
    })
    expect(record.status).toBe('running')
    expect(record.backgroundTasks).toBe(3)
  })

  it('subagent_stop keeps the session running while work remains', () => {
    const record = transitionSession(stopWith(3), {
      event: 'subagent_stop',
      session_id: 'test-session',
      background_tasks: 2,
      source: 'claude',
    })
    expect(record.status).toBe('running')
    expect(record.statusLabel).toBe('2 background tasks running')
    expect(record.backgroundTasks).toBe(2)
  })

  it('subagent_stop reaching zero records the count without changing the view', () => {
    const idle = stopWith(0)
    const record = transitionSession(idle, {
      event: 'subagent_stop',
      session_id: 'test-session',
      background_tasks: 0,
      source: 'claude',
    })
    // Fires for internal utility agents too — flashing "running" here would be
    // the inverse of the false-idle bug.
    expect(record).toBe(idle)
  })

  it('the last subagent finishing hands an already-ended turn back to the user', () => {
    // Nothing else fires here: the turn's Stop already happened, and it was
    // suppressed because background work was still in flight.
    const record = transitionSession(stopWith(1), {
      event: 'subagent_stop',
      session_id: 'test-session',
      background_tasks: 0,
      source: 'claude',
    })
    expect(record.status).toBe('waiting_for_input')
    expect(record.needsAttention).toBe(true)
    expect(record.statusLabel).toBeUndefined()
    expect(record.backgroundTasks).toBe(0)
    expect(record.idleWithBackground).toBe(false)
  })

  it('a subagent finishing mid-turn only updates the count', () => {
    const busy = transitionSession(running(), {
      event: 'subagent_stop',
      session_id: 'test-session',
      background_tasks: 2,
      source: 'claude',
    })
    const record = transitionSession(busy, {
      event: 'subagent_stop',
      session_id: 'test-session',
      background_tasks: 0,
      source: 'claude',
    })
    expect(record.status).toBe('running')
    expect(record.needsAttention).toBe(false)
    expect(record.backgroundTasks).toBe(0)
  })

  it('subagent_stop never resurrects a retired session', () => {
    const dead = transitionSession(running(), {
      event: 'session_end',
      session_id: 'test-session',
      pid: 42,
      source: 'claude',
    })
    const record = transitionSession(dead, {
      event: 'subagent_stop',
      session_id: 'test-session',
      background_tasks: 1,
      source: 'claude',
    })
    expect(record).toBe(dead)
  })

  it('subagent_stop does not take the attention dot off a finished turn', () => {
    const idle = stopWith(0)
    expect(idle.needsAttention).toBe(true)
    const record = transitionSession(idle, {
      event: 'subagent_stop',
      session_id: 'test-session',
      background_tasks: 1,
      source: 'claude',
    })
    expect(record.status).toBe('waiting_for_input')
    expect(record.needsAttention).toBe(true)
    expect(record.backgroundTasks).toBe(1)
  })

  it('a prompt still applies while only background work keeps the row busy', () => {
    const record = transitionSession(stopWith(2), {
      event: 'user_prompt_submit',
      session_id: 'test-session',
      prompt: 'next thing',
      source: 'claude',
    })
    expect(record.status).toBe('running')
    expect(record.subtitle).toBe('next thing')
    expect(record.idleWithBackground).toBe(false)
  })

  it('tool_completed leaves a background-only session alone', () => {
    const busy = stopWith(2)
    const record = transitionSession(busy, {
      event: 'tool_completed',
      session_id: 'test-session',
      tool_name: 'Bash',
      source: 'claude',
    })
    expect(record).toBe(busy)
  })

  it('a new session start clears the carried-over count', () => {
    const record = transitionSession(stopWith(2), makeStart())
    expect(record.backgroundTasks).toBe(0)
  })
})

describe('a question survives tools running alongside it', () => {
  const ask = (session_id: string): HookEvent => ({
    event: 'pre_tool_use',
    session_id,
    tool_name: 'AskUserQuestion',
  })
  const bash = (session_id: string): HookEvent => ({
    event: 'pre_tool_use',
    session_id,
    tool_name: 'Bash',
  })
  const completed = (session_id: string, tool_name: string): HookEvent => ({
    event: 'tool_completed',
    session_id,
    tool_name,
  })

  const asking = (): SessionRecord =>
    transitionSession(
      createSession({ event: 'session_start', session_id: 's1', pid: 1 }),
      ask('s1'),
      true,
    )

  it('raises attention when the question is asked', () => {
    const record = asking()
    expect(record.needsAttention).toBe(true)
    expect(record.activeBlockingTool).toBe('AskUserQuestion')
  })

  it('keeps attention when another tool starts in parallel', () => {
    // Claude issues tool calls in parallel; a Bash starting says nothing about
    // whether the question has been answered.
    const record = transitionSession(asking(), bash('s1'), true)
    expect(record.needsAttention).toBe(true)
    expect(record.activeBlockingTool).toBe('AskUserQuestion')
  })

  it('keeps the question as the status label, not the parallel tool', () => {
    const record = transitionSession(asking(), bash('s1'), true)
    expect(record.statusLabel).toBe('Running: AskUserQuestion')
  })

  it('ignores a parallel tool completing', () => {
    let record = transitionSession(asking(), bash('s1'), true)
    record = transitionSession(record, completed('s1', 'Bash'), true)
    expect(record.needsAttention).toBe(true)
  })

  it('retires the question when it is answered', () => {
    let record = transitionSession(asking(), bash('s1'), true)
    record = transitionSession(record, completed('s1', 'AskUserQuestion'), true)
    expect(record.needsAttention).toBe(false)
    expect(record.activeBlockingTool).toBeUndefined()
  })

  it('still advances the timestamp while blocked', () => {
    const before = asking()
    const after = transitionSession(before, bash('s1'), true)
    expect(after.lastEventAt).toBeGreaterThanOrEqual(before.lastEventAt)
  })

  it('lets an ordinary tool set its label when nothing is blocking', () => {
    const running = transitionSession(
      createSession({ event: 'session_start', session_id: 's2', pid: 2 }),
      bash('s2'),
      true,
    )
    expect(running.statusLabel).toBe('Running: Bash')
    expect(running.needsAttention).toBe(false)
  })
})
