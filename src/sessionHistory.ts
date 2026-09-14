import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readTitleFromFile } from './slugResolver.js'
import type { HistoryEntry } from './viewModel.js'

export const DEFAULT_HISTORY_HOURS = 24

/** Bounds the directory probing done while decoding one project folder name. */
const MAX_DECODE_STEPS = 400

const isDirectory = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Claude names a project folder by replacing every `/` in the cwd with `-`,
 * which is lossy: `-home-me-claude-terminal-manager` could be
 * `/home/me/claude-terminal-manager` or `/home/me/claude/terminal/manager`.
 *
 * So we never reverse the replacement. Instead we walk the real filesystem from
 * the root, and at each level try the longest run of tokens that names a
 * directory that actually exists. `candidates` short-circuits the walk for
 * paths we already know about (open workspace folders, live sessions), which is
 * both faster and immune to a directory having since been renamed.
 */
export const decodeProjectFolder = (
  folder: string,
  candidates: readonly string[] = [],
): string | undefined => {
  for (const candidate of candidates) {
    if (encodeProjectFolder(candidate) === folder) return candidate
  }
  if (!folder.startsWith('-')) return undefined

  const tokens = folder.slice(1).split('-')
  let steps = 0

  const walk = (dir: string, i: number): string | undefined => {
    if (i >= tokens.length) return dir
    let name = ''
    for (let j = i; j < tokens.length; j += 1) {
      name = name === '' ? tokens[j]! : `${name}-${tokens[j]!}`
      if (steps > MAX_DECODE_STEPS) return undefined
      steps += 1
      const next = path.join(dir, name)
      if (!isDirectory(next)) continue
      const found = walk(next, j + 1)
      if (found !== undefined) return found
    }
    return undefined
  }

  return walk(path.sep, 0)
}

/** The forward direction, which is exact. */
export const encodeProjectFolder = (cwd: string): string =>
  cwd.replaceAll('/', '-')

export const projectsRoot = (): string =>
  path.join(os.homedir(), '.claude', 'projects')

interface CacheEntry {
  readonly mtimeMs: number
  readonly title: string | undefined
}

// Titles are stable for a given file version, and reading one means a 64 KB
// tail read. Keyed by path, invalidated by mtime.
const titleCache = new Map<string, CacheEntry>()

export interface ReadHistoryOptions {
  readonly hours: number
  readonly now: number
  /** Paths we already know, used to skip the filesystem walk. */
  readonly knownCwds: readonly string[]
  readonly root?: string
}

/**
 * Index the sessions that ended inside the history window.
 *
 * Shape on disk: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, so the
 * file name is the session id and the mtime is when the session last wrote.
 */
export const readSessionHistory = async (
  options: ReadHistoryOptions,
): Promise<readonly HistoryEntry[]> => {
  if (options.hours <= 0) return []

  const root = options.root ?? projectsRoot()
  const cutoff = options.now - options.hours * 3600_000

  let folders: string[]
  try {
    folders = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }

  const entries: HistoryEntry[] = []

  for (const folder of folders) {
    const dir = path.join(root, folder)

    let files: Array<{ id: string; file: string; mtimeMs: number }>
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const file = path.join(dir, f)
          let mtimeMs = 0
          try {
            mtimeMs = fs.statSync(file).mtimeMs
          } catch {
            mtimeMs = 0
          }
          return { id: f.slice(0, -'.jsonl'.length), file, mtimeMs }
        })
        .filter((f) => f.mtimeMs >= cutoff)
    } catch {
      continue
    }

    if (files.length === 0) continue

    // Only pay for the path walk once we know the folder has recent sessions.
    const cwd = decodeProjectFolder(folder, options.knownCwds)
    if (cwd === undefined) continue

    for (const f of files) {
      const cached = titleCache.get(f.file)
      let title: string | undefined
      if (cached !== undefined && cached.mtimeMs === f.mtimeMs) {
        title = cached.title
      } else {
        title = await readTitleFromFile(f.file, { fullScanFallback: false })
        titleCache.set(f.file, { mtimeMs: f.mtimeMs, title })
      }
      entries.push({ id: f.id, cwd, title, endedAt: f.mtimeMs })
    }
  }

  return entries.sort((a, b) => b.endedAt - a.endedAt)
}

/** Locate the working directory a past session ran in, so it can be resumed. */
export const findSessionCwd = (
  sessionId: string,
  knownCwds: readonly string[] = [],
  root: string = projectsRoot(),
): string | undefined => {
  let folders: string[]
  try {
    folders = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return undefined
  }
  for (const folder of folders) {
    if (!fs.existsSync(path.join(root, folder, `${sessionId}.jsonl`))) continue
    return decodeProjectFolder(folder, knownCwds)
  }
  return undefined
}

/** Exposed for tests — the title cache is process-wide. */
export const clearHistoryTitleCache = (): void => {
  titleCache.clear()
}
