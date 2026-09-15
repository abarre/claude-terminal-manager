import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * How many tokens a session is currently carrying, read from its transcript.
 *
 * Claude records a `usage` block on every assistant message. The last one is
 * the size of the context that produced it, which is what the panel shows next
 * to the age — a session at 400k reads very differently from one at 20k, and
 * nothing else in the row says so. A `/compact` shrinks the next block, so the
 * number comes back down on its own.
 */

// Same 256 KB tail as the title read: enough to reach the last assistant
// message in every file we have seen, without paying for the whole transcript.
const TAIL_SIZE = 262144

/** `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. */
export const transcriptPath = (cwd: string, sessionId: string): string =>
  path.join(
    os.homedir(),
    '.claude',
    'projects',
    cwd.replaceAll('/', '-'),
    `${sessionId}.jsonl`,
  )

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined

const numberAt = (usage: Record<string, unknown>, key: string): number => {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Total context of the last assistant turn in a chunk of transcript.
 *
 * Everything the model was billed for on that turn is context it still holds:
 * fresh input, both halves of the cache, and its own reply. Sub-agent turns are
 * skipped — they run in a context of their own, not the session's.
 */
export const contextTokensFromTail = (tail: string): number | undefined => {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!
    if (!line.includes('"usage"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // A truncated first line, or something we do not understand.
    }
    const entry = record(parsed)
    if (entry === undefined) continue
    if (entry['type'] !== 'assistant' || entry['isSidechain'] === true) continue
    const message = record(entry['message'])
    const usage = message === undefined ? undefined : record(message['usage'])
    if (usage === undefined) continue
    const total =
      numberAt(usage, 'input_tokens') +
      numberAt(usage, 'cache_creation_input_tokens') +
      numberAt(usage, 'cache_read_input_tokens') +
      numberAt(usage, 'output_tokens')
    return total > 0 ? total : undefined
  }
  return undefined
}

interface CacheEntry {
  readonly mtimeMs: number
  readonly tokens: number | undefined
}

// A transcript only grows, so its mtime settles the question of whether the
// number we already read is still the current one.
const cache = new Map<string, CacheEntry>()

/** Context size of one transcript, or undefined if it has no assistant turn yet. */
export const readContextTokens = (
  jsonlPath: string,
  tailSize: number = TAIL_SIZE,
): number | undefined => {
  let fd: number | undefined
  try {
    const stat = fs.statSync(jsonlPath)
    const cached = cache.get(jsonlPath)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
      return cached.tokens
    }

    fd = fs.openSync(jsonlPath, 'r')
    const size = Math.min(stat.size, tailSize)
    const buf = Buffer.alloc(size)
    const read = fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size))
    const tokens = contextTokensFromTail(buf.toString('utf8', 0, read))

    cache.set(jsonlPath, { mtimeMs: stat.mtimeMs, tokens })
    return tokens
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Context size of a session, addressed the way the rest of the panel does. */
export const readSessionContextTokens = (
  cwd: string,
  sessionId: string,
): number | undefined => readContextTokens(transcriptPath(cwd, sessionId))

/** Exposed for tests — the cache is process-wide. */
export const clearContextTokenCache = (): void => {
  cache.clear()
}
