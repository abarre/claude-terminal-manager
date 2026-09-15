import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  clearContextTokenCache,
  contextTokensFromTail,
  readContextTokens,
  transcriptPath,
} from './contextSize.js'

const assistant = (
  usage: Record<string, number>,
  over: Record<string, unknown> = {},
): string =>
  JSON.stringify({ type: 'assistant', message: { usage }, ...over })

const USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 4000,
  cache_read_input_tokens: 54_000,
  output_tokens: 200,
}

describe('contextTokensFromTail', () => {
  it('sums the fresh input, both caches and the reply', () => {
    expect(contextTokensFromTail(assistant(USAGE))).toBe(58_202)
  })

  it('takes the last assistant turn, not the largest', () => {
    const tail = [
      assistant({ ...USAGE, cache_read_input_tokens: 900_000 }),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistant(USAGE),
    ].join('\n')
    expect(contextTokensFromTail(tail)).toBe(58_202)
  })

  it('ignores sub-agent turns, which hold a context of their own', () => {
    const tail = [
      assistant(USAGE),
      assistant({ ...USAGE, cache_read_input_tokens: 1000 }, { isSidechain: true }),
    ].join('\n')
    expect(contextTokensFromTail(tail)).toBe(58_202)
  })

  it('tolerates the truncated first line a tail read leaves behind', () => {
    expect(contextTokensFromTail(`ken":4,"usage":{"inp\n${assistant(USAGE)}`)).toBe(
      58_202,
    )
  })

  it('treats a missing field as zero rather than giving up', () => {
    expect(contextTokensFromTail(assistant({ input_tokens: 120 }))).toBe(120)
  })

  it('returns nothing for a transcript with no assistant turn yet', () => {
    expect(
      contextTokensFromTail(JSON.stringify({ type: 'user', message: {} })),
    ).toBeUndefined()
  })

  it('returns nothing for an empty chunk', () => {
    expect(contextTokensFromTail('')).toBeUndefined()
  })
})

describe('transcriptPath', () => {
  it('encodes the cwd the way Claude names its project folders', () => {
    expect(transcriptPath('/home/me/fstrz', 'abc')).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-home-me-fstrz', 'abc.jsonl'),
    )
  })
})

describe('readContextTokens', () => {
  let dir: string

  beforeEach(() => {
    clearContextTokenCache()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-context-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const write = (lines: readonly string[]): string => {
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return file
  }

  it('reads the last usage block in the file', () => {
    expect(readContextTokens(write([assistant(USAGE)]))).toBe(58_202)
  })

  it('only looks at the tail, so an early turn does not resurface', () => {
    const filler = JSON.stringify({ type: 'user', text: 'x'.repeat(2000) })
    const file = write([assistant(USAGE), ...Array<string>(20).fill(filler)])
    expect(readContextTokens(file, 4096)).toBeUndefined()
  })

  it('returns nothing for a file that is not there', () => {
    expect(readContextTokens(path.join(dir, 'gone.jsonl'))).toBeUndefined()
  })

  it('re-reads once the transcript has been written to again', () => {
    const file = write([assistant(USAGE)])
    expect(readContextTokens(file)).toBe(58_202)
    fs.appendFileSync(file, assistant({ input_tokens: 70_000 }) + '\n')
    // The cache is keyed by mtime, which appendFileSync has just moved on.
    fs.utimesSync(file, new Date(), new Date(Date.now() + 1000))
    expect(readContextTokens(file)).toBe(70_000)
  })
})
