import * as fs from 'node:fs'
import * as path from 'node:path'
import { Effect } from 'effect'

export interface RemoteSessionInfo {
  readonly sessionId: string
  readonly status: string
  readonly subtitle: string | undefined
  readonly statusLabel: string | undefined
  readonly needsAttention?: boolean
  readonly slug?: string
  readonly customName?: string
  readonly source?: string
  // Added for the panel redesign. Optional, so a window still running an older
  // version publishes an entry we can read — its rows simply show less.
  readonly cwd?: string
  readonly backgroundTasks?: number
  readonly lastEventAt?: number
}

export interface RemoteTerminalInfo {
  readonly name: string
  readonly pid?: number
  readonly customName?: string
  readonly session?: RemoteSessionInfo
}

export interface WindowEntry {
  readonly windowId: string
  readonly workspaceName: string
  readonly workspaceFolderPath?: string
  readonly branch?: string
  readonly socketPath: string
  readonly terminals: ReadonlyArray<RemoteTerminalInfo>
  readonly lastHeartbeat: number
}

export const getWindowEntryPath = (
  globalStoragePath: string,
  windowId: string,
): string => path.join(globalStoragePath, 'window-' + windowId + '.json')

/**
 * Publish this window's entry atomically.
 *
 * `writeFileSync` truncates before writing, so a reader in another window can
 * observe a half-written file. Because a failed parse drops the whole entry,
 * that showed up as the window's sessions blinking out of the panel and back
 * every couple of seconds. Writing to a sibling and renaming means a reader
 * sees either the old file or the new one, never a partial one.
 */
export const writeWindowEntry = (
  globalStoragePath: string,
  entry: WindowEntry,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    const target = getWindowEntryPath(globalStoragePath, entry.windowId)
    // Unique per window, and these calls are synchronous, so no two writes
    // from this process can interleave on it.
    const temporary = target + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(entry))
    fs.renameSync(temporary, target)
  }).pipe(
    Effect.catchAll((e) =>
      Effect.logWarning('writeWindowEntry failed: ' + String(e)),
    ),
  )

/**
 * Read one entry, retrying once on a parse failure.
 *
 * Belt-and-braces alongside the atomic write: a single retry costs nothing and
 * covers any writer that has not been updated yet, rather than silently losing
 * a window for a poll.
 */
const readEntry = (file: string): WindowEntry | undefined => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as WindowEntry
    } catch {
      // fall through and try once more
    }
  }
  return undefined
}

export const readAllWindowEntries = (
  globalStoragePath: string,
  ownWindowId: string,
  maxAgeMs?: number,
  ownWorkspaceFolderPath?: string,
): Effect.Effect<ReadonlyArray<WindowEntry>, never> =>
  Effect.sync((): ReadonlyArray<WindowEntry> => {
    try {
      const now = Date.now()
      const maxAge = maxAgeMs ?? 90_000
      const files = fs.readdirSync(globalStoragePath)
      const result: WindowEntry[] = []
      for (const file of files) {
        if (!file.startsWith('window-') || !file.endsWith('.json')) continue
        if (file === 'window-' + ownWindowId + '.json') continue
        try {
          const entry = readEntry(path.join(globalStoragePath, file))
          if (entry === undefined) continue
          if (now - entry.lastHeartbeat > maxAge) continue
          if (
            ownWorkspaceFolderPath !== undefined &&
            entry.workspaceFolderPath === ownWorkspaceFolderPath
          )
            continue
          result.push(entry)
        } catch {
          // Skip files that fail to parse or read
        }
      }
      // Deduplicate remote entries by workspaceFolderPath, keeping the freshest
      const deduped = new Map<string, WindowEntry>()
      for (const entry of result) {
        const key = entry.workspaceFolderPath ?? entry.windowId
        const existing = deduped.get(key)
        if (existing === undefined || entry.lastHeartbeat > existing.lastHeartbeat) {
          deduped.set(key, entry)
        }
      }
      return Array.from(deduped.values())
    } catch {
      return []
    }
  })

export const deleteWindowEntry = (
  globalStoragePath: string,
  windowId: string,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    fs.unlinkSync(getWindowEntryPath(globalStoragePath, windowId))
  }).pipe(Effect.catchAll(() => Effect.void))

export const pruneDuplicateWindowFiles = (
  globalStoragePath: string,
  ownWindowId: string,
  ownWorkspaceFolderPath: string | undefined,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    if (ownWorkspaceFolderPath === undefined) return
    const files = fs.readdirSync(globalStoragePath)
    for (const file of files) {
      if (!file.startsWith('window-') || !file.endsWith('.json')) continue
      if (file === 'window-' + ownWindowId + '.json') continue
      const filePath = path.join(globalStoragePath, file)
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const entry = JSON.parse(content) as WindowEntry
        if (entry.workspaceFolderPath === ownWorkspaceFolderPath) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // Skip files that can't be read or parsed
      }
    }
  }).pipe(Effect.catchAll(() => Effect.void))

// CTM-4829
export const pruneStaleWindowFiles = (
  globalStoragePath: string,
  maxAgeMs?: number,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    const now = Date.now()
    const maxAge = maxAgeMs ?? 90_000
    const files = fs.readdirSync(globalStoragePath)
    for (const file of files) {
      if (!file.startsWith('window-') || !file.endsWith('.json')) continue
      const filePath = path.join(globalStoragePath, file)
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const entry = JSON.parse(content) as WindowEntry
        if (now - entry.lastHeartbeat > maxAge) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // Skip files that can't be read or parsed
      }
    }
  }).pipe(Effect.catchAll(() => Effect.void))
