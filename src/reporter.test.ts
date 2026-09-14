import * as cp from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPORTER = fileURLToPath(new URL('../bin/reporter', import.meta.url))

const makeSockPath = (): string =>
  path.join(os.tmpdir(), 'reporter-test-' + process.pid + '-' + Date.now() + '.sock')

/**
 * Start a Unix socket server, run bin/reporter with the given args and stdin,
 * and return the first line received on the socket.
 */
const runReporter = (
  args: string[],
  stdinJson: object,
  sockPath: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    let received = ''

    const server = net.createServer((conn) => {
      conn.on('data', (chunk) => {
        received += chunk.toString()
      })
      conn.on('end', () => {
        server.close()
        resolve(received.trim())
      })
    })

    server.on('error', reject)

    server.listen(sockPath, () => {
      const proc = cp.spawn('bash', [REPORTER, ...args], {
        env: { ...process.env, VSCODE_CLAUDE_SOCKET: sockPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      proc.stdin!.write(JSON.stringify(stdinJson))
      proc.stdin!.end()
      proc.on('error', reject)
    })
  })

describe('bin/reporter', () => {
  const sockPaths: string[] = []

  afterEach(() => {
    for (const p of sockPaths) {
      try {
        fs.unlinkSync(p)
      } catch {
        // best-effort
      }
    }
    sockPaths.length = 0
  })

  it('sends session_start with pid when --pid is given', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      ['--save-session', '/dev/null', '--pid', '99999'],
      { session_id: 'sess-a', hook_event_name: 'SessionStart' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('session_start')
    expect(parsed['session_id']).toBe('sess-a')
    expect(parsed['pid']).toBe(99999)
  })

  it('sends session_start with pid=0 when --pid is not given', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      ['--save-session', '/dev/null'],
      { session_id: 'sess-b', hook_event_name: 'SessionStart' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('session_start')
    expect(parsed['session_id']).toBe('sess-b')
    expect(parsed['pid']).toBe(0)
  })

  it('sends stop event with stop_reason when present', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-sr',
        hook_event_name: 'Stop',
        stop_reason: 'end_turn',
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('stop')
    expect(parsed['session_id']).toBe('sess-sr')
    expect(parsed['stop_reason']).toBe('end_turn')
  })

  it('sends stop event without stop_reason when absent', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-ns',
        hook_event_name: 'Stop',
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('stop')
    expect(parsed['session_id']).toBe('sess-ns')
    expect('stop_reason' in parsed).toBe(false)
  })

  it('sends user_prompt_submit without pid field', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-c',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hello world',
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('user_prompt_submit')
    expect(parsed['session_id']).toBe('sess-c')
    expect(parsed['prompt']).toBe('hello world')
    expect('pid' in parsed).toBe(false)
  })

  it('sends tool_interrupted for an interrupted PostToolUse result', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-interrupted',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_response: { stdout: '', stderr: '', interrupted: true },
      },
      sockPath,
    )

    expect(JSON.parse(line)).toEqual({
      event: 'tool_interrupted',
      session_id: 'sess-interrupted',
      source: 'claude',
      tool_name: 'Bash',
    })
  })

  it('sends tool_interrupted for an interrupt-style tool failure', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-aborted',
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        is_interrupt: true,
      },
      sockPath,
    )

    expect(JSON.parse(line)).toEqual({
      event: 'tool_interrupted',
      session_id: 'sess-aborted',
      source: 'claude',
      tool_name: 'Bash',
    })
  })
})

describe('--source flag (T5.3)', () => {
  const sockPaths: string[] = []

  afterEach(() => {
    for (const sockPath of sockPaths) {
      try {
        fs.unlinkSync(sockPath)
      } catch {
        // best-effort
      }
    }
    sockPaths.length = 0
  })

  it('(a) without --source, emitted event has source=claude', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      { session_id: 'abc', hook_event_name: 'Stop' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['source']).toBe('claude')
  })

  it('(b) with --source codex, emitted event has source=codex', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      ['--source', 'codex'],
      { session_id: 'abc', hook_event_name: 'Stop' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['source']).toBe('codex')
  })

  it('(c) --source flag with SessionStart includes source alongside pid', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      ['--source', 'codex', '--pid', '123'],
      { session_id: 'abc', hook_event_name: 'SessionStart' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['source']).toBe('codex')
    expect(parsed['pid']).toBe(123)
    expect(parsed['event']).toBe('session_start')
  })

  it('maps PermissionRequest to permission_request with an Allow summary', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-perm',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf   build' },
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('permission_request')
    expect(parsed['tool_name']).toBe('Bash')
    expect(parsed['detail']).toBe('Allow Bash: rm -rf build?')
  })

  it('shows the question itself for an AskUserQuestion permission', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-ask',
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which database?' }] },
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['detail']).toBe('Which database?')
  })

  it('shortens an mcp tool name in the permission summary', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-mcp',
        hook_event_name: 'PermissionRequest',
        tool_name: 'mcp__shortcut__stories-update',
        tool_input: {},
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['detail']).toBe('Allow shortcut/stories-update?')
  })

  it('maps StopFailure to stop so a failed turn does not strand as running', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      { session_id: 'sess-sf', hook_event_name: 'StopFailure' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('stop')
    expect(parsed['session_id']).toBe('sess-sf')
  })

  it('counts only still-running background tasks on Stop', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-bg',
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'a', status: 'running' },
          { id: 'b', status: 'completed' },
          { id: 'c' },
        ],
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    // 'c' has no status: unknown counts as active, since an over-count only
    // delays the idle dot while an under-count fakes idleness.
    expect(parsed['background_tasks']).toBe(2)
  })

  it('omits background_tasks entirely when the payload has no such field', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      { session_id: 'sess-legacy', hook_event_name: 'Stop' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect('background_tasks' in parsed).toBe(false)
  })

  it('excludes the just-stopped agent from a SubagentStop count', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-sub',
        hook_event_name: 'SubagentStop',
        agent_id: 'a',
        background_tasks: [
          { id: 'a', status: 'running' },
          { id: 'z', status: 'running' },
        ],
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('subagent_stop')
    expect(parsed['background_tasks']).toBe(1)
  })

  it('maps SessionEnd to session_end', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      { session_id: 'sess-end', hook_event_name: 'SessionEnd' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('session_end')
    expect(parsed['session_id']).toBe('sess-end')
  })

  it('sends tool_completed for an ordinary PostToolUse result', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-done',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_response: { ok: true },
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('tool_completed')
    expect(parsed['tool_name']).toBe('Bash')
  })
})
