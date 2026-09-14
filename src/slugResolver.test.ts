import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Effect } from 'effect'
import { resolveSessionSlug, readLatestSlug } from './slugResolver.js'

vi.mock('vscode', () => ({
  window: { terminals: [] },
  workspace: { getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }) },
  EventEmitter: class { event = vi.fn(); fire = vi.fn(); dispose = vi.fn() },
  TreeItem: class { constructor(public label: string) {} },
  TreeItemCollapsibleState: { None: 0 },
}))

describe('resolveSessionSlug', () => {
  const testCwd = '/Users/test/projects/my-project'
  const sessionId = 'abc-123-def'
  const encodedCwd = testCwd.replaceAll('/', '-')
  const jsonlDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd)
  const jsonlPath = path.join(jsonlDir, `${sessionId}.jsonl`)

  beforeEach(() => {
    fs.mkdirSync(jsonlDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.unlinkSync(jsonlPath)
    } catch {
      // file may not exist
    }
    try {
      fs.rmdirSync(jsonlDir)
    } catch {
      // dir may not be empty or not exist
    }
  })

  it('extracts slug from JSONL file', async () => {
    const lines = [
      JSON.stringify({ type: 'system', message: 'init' }),
      JSON.stringify({ type: 'user', slug: 'tighten-requested-chains' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(resolveSessionSlug(testCwd, sessionId))
    expect(result).toBe('tighten-requested-chains')
  })

  it('returns undefined when file does not exist', async () => {
    const result = await Effect.runPromise(
      resolveSessionSlug('/nonexistent/path', 'no-such-session'),
    )
    expect(result).toBeUndefined()
  })

  it('returns undefined when no slug field in file', async () => {
    const lines = [
      JSON.stringify({ type: 'system', message: 'init' }),
      JSON.stringify({ type: 'user', message: 'hello' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(resolveSessionSlug(testCwd, sessionId))
    expect(result).toBeUndefined()
  })

  it('skips malformed JSON lines', async () => {
    const lines = [
      'not valid json',
      JSON.stringify({ type: 'user', slug: 'valid-slug' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(resolveSessionSlug(testCwd, sessionId))
    expect(result).toBe('valid-slug')
  })

  it('ignores empty slug strings', async () => {
    const lines = [
      JSON.stringify({ type: 'user', slug: '' }),
      JSON.stringify({ type: 'user', slug: 'real-slug' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(resolveSessionSlug(testCwd, sessionId))
    expect(result).toBe('real-slug')
  })

  it('prefers customTitle over slug', async () => {
    const lines = [
      JSON.stringify({ type: 'user', slug: 'random-generated-slug' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'fix-fee-playground-regression', sessionId: 'abc' }),
      JSON.stringify({ type: 'assistant', slug: 'random-generated-slug' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(resolveSessionSlug(testCwd, sessionId))
    expect(result).toBe('fix-fee-playground-regression')
  })

  it('falls back to slug when no customTitle', async () => {
    const lines = [
      JSON.stringify({ type: 'user', slug: 'random-generated-slug' }),
      JSON.stringify({ type: 'assistant', slug: 'random-generated-slug' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(resolveSessionSlug(testCwd, sessionId))
    expect(result).toBe('random-generated-slug')
  })
})

describe('readLatestSlug', () => {
  const testCwd = '/Users/test/projects/my-project'
  const sessionId = 'abc-123-def'
  const encodedCwd = testCwd.replaceAll('/', '-')
  const jsonlDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd)
  const jsonlPath = path.join(jsonlDir, `${sessionId}.jsonl`)

  beforeEach(() => {
    fs.mkdirSync(jsonlDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.unlinkSync(jsonlPath)
    } catch {
      // file may not exist
    }
    try {
      fs.rmdirSync(jsonlDir)
    } catch {
      // dir may not be empty or not exist
    }
  })

  it('prefers the ai-title over the random slug', async () => {
    // "wobbly-painting-grove" means nothing to a human; the ai-title does.
    const lines = [
      JSON.stringify({ type: 'user', slug: 'wobbly-painting-grove' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'View by shortcut ticket', sessionId: 'abc' }),
      JSON.stringify({ type: 'assistant', slug: 'wobbly-painting-grove' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(readLatestSlug(testCwd, sessionId))
    expect(result).toBe('View by shortcut ticket')
  })

  it('takes the last ai-title, since it is refreshed as the topic moves', async () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'An early guess', sessionId: 'abc' }),
      JSON.stringify({ type: 'user', slug: 'wobbly-painting-grove' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'What it became', sessionId: 'abc' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(readLatestSlug(testCwd, sessionId))
    expect(result).toBe('What it became')
  })

  it('prefers an explicit rename over the ai-title', async () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Generated title', sessionId: 'abc' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'What I called it', sessionId: 'abc' }),
      JSON.stringify({ type: 'user', slug: 'wobbly-painting-grove' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(readLatestSlug(testCwd, sessionId))
    expect(result).toBe('What I called it')
  })

  it('returns customTitle when present in file', async () => {
    const lines = [
      JSON.stringify({ type: 'user', slug: 'random-slug' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'my-custom-title', sessionId: 'abc' }),
      JSON.stringify({ type: 'assistant', slug: 'random-slug' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(readLatestSlug(testCwd, sessionId))
    expect(result).toBe('my-custom-title')
  })

  it('returns slug when no customTitle', async () => {
    const lines = [
      JSON.stringify({ type: 'user', slug: 'random-slug' }),
      JSON.stringify({ type: 'assistant', slug: 'random-slug' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(readLatestSlug(testCwd, sessionId))
    expect(result).toBe('random-slug')
  })

  it('returns undefined when file does not exist', async () => {
    const result = await Effect.runPromise(
      readLatestSlug('/nonexistent/path', 'no-such-session'),
    )
    expect(result).toBeUndefined()
  })

  it('reads customTitle from head when only slug in tail (large file)', async () => {
    // Simulate a large file where customTitle is in the head
    // and only slug entries are in the tail
    const headLines = [
      JSON.stringify({ type: 'user', slug: 'random-slug' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'my-title', sessionId: 'abc' }),
    ]
    // Generate enough data to push the head beyond the 16KB tail window
    const padding: string[] = []
    for (let i = 0; i < 200; i++) {
      padding.push(JSON.stringify({ type: 'assistant', slug: 'random-slug', message: 'x'.repeat(100) }))
    }
    fs.writeFileSync(jsonlPath, [...headLines, ...padding].join('\n') + '\n')

    const result = await Effect.runPromise(readLatestSlug(testCwd, sessionId))
    expect(result).toBe('my-title')
  })

  it('returns the last customTitle when multiple exist', async () => {
    const lines = [
      JSON.stringify({ type: 'user', slug: 'random-slug' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'first-title', sessionId: 'abc' }),
      JSON.stringify({ type: 'assistant', slug: 'random-slug' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'renamed-title', sessionId: 'abc' }),
      JSON.stringify({ type: 'assistant', slug: 'random-slug' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await Effect.runPromise(readLatestSlug(testCwd, sessionId))
    expect(result).toBe('renamed-title')
  })
})
