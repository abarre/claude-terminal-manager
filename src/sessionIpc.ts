import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * A request for whichever window owns a folder to open an agent session there.
 *
 * Keyed by folder rather than by window id, because the target window may not
 * exist yet: acting on a project you have no window open for launches one, and
 * that new window claims the request when it activates.
 *
 * `sessionId` absent means a fresh session; present means `--resume <id>`.
 */
export interface SessionRequest {
  readonly cwd: string
  readonly sessionId?: string
  readonly timestamp: number
}

/**
 * How long a request stays claimable. Long enough for a cold VS Code window to
 * start and activate the extension, short enough that a request abandoned
 * because the window never opened does not fire days later.
 */
export const REQUEST_TTL_MS = 180_000

export const REQUEST_PREFIX = 'session-request-'

/**
 * Folder paths are not filename-safe, so the key is a hash of the path.
 *
 * The key is the *workspace folder* that will claim the request, which is not
 * always the session's cwd — a session can run in a subdirectory of the folder
 * the window has open. The cwd travels in the payload instead.
 */
export const sessionRequestPath = (
  globalStoragePath: string,
  folderKey: string,
): string =>
  path.join(
    globalStoragePath,
    `${REQUEST_PREFIX}${createHash('sha1').update(folderKey).digest('hex').slice(0, 16)}.json`,
  )

export const isSessionRequestFile = (filename: string): boolean =>
  filename.startsWith(REQUEST_PREFIX) && filename.endsWith('.json')

export const writeSessionRequest = (
  globalStoragePath: string,
  folderKey: string,
  cwd: string,
  sessionId: string | undefined,
  now: number = Date.now(),
): boolean => {
  try {
    const request: SessionRequest = {
      cwd,
      ...(sessionId !== undefined ? { sessionId } : {}),
      timestamp: now,
    }
    fs.writeFileSync(
      sessionRequestPath(globalStoragePath, folderKey),
      JSON.stringify(request),
    )
    return true
  } catch {
    return false
  }
}

/**
 * Take the pending request for one of this window's folders, if there is one.
 *
 * Claiming deletes the file first so two windows opened on the same folder
 * cannot both act on it.
 */
export const claimSessionRequest = (
  globalStoragePath: string,
  folderPaths: readonly string[],
  now: number = Date.now(),
): SessionRequest | undefined => {
  for (const folder of folderPaths) {
    const file = sessionRequestPath(globalStoragePath, folder)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    try {
      fs.unlinkSync(file)
    } catch {
      // Another window got there first; let it handle the request.
      continue
    }
    try {
      const request = JSON.parse(raw) as SessionRequest
      if (typeof request.cwd !== 'string') continue
      if (
        request.sessionId !== undefined &&
        typeof request.sessionId !== 'string'
      ) {
        continue
      }
      if (now - request.timestamp > REQUEST_TTL_MS) continue
      return request
    } catch {
      continue
    }
  }
  return undefined
}

/** Drop requests left behind by a window that never opened. */
export const pruneStaleSessionRequests = (
  globalStoragePath: string,
  now: number = Date.now(),
): void => {
  let files: string[]
  try {
    files = fs.readdirSync(globalStoragePath)
  } catch {
    return
  }
  for (const filename of files) {
    if (!isSessionRequestFile(filename)) continue
    const file = path.join(globalStoragePath, filename)
    try {
      const request = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionRequest
      if (now - request.timestamp <= REQUEST_TTL_MS) continue
    } catch {
      // Unreadable: treat as stale.
    }
    try {
      fs.unlinkSync(file)
    } catch {
      // best-effort
    }
  }
}
