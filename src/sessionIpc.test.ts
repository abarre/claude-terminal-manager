import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  REQUEST_TTL_MS,
  claimSessionRequest,
  isSessionRequestFile,
  pruneStaleSessionRequests,
  sessionRequestPath,
  writeSessionRequest,
} from './sessionIpc.js'

let dir: string
const NOW = 1_700_000_000_000

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-ipc-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('sessionRequestPath', () => {
  it('turns a folder path into a filename-safe key', () => {
    const file = sessionRequestPath(dir, '/Users/me/my repo/sub')
    expect(path.dirname(file)).toBe(dir)
    expect(path.basename(file)).toMatch(/^session-request-[0-9a-f]{16}\.json$/)
  })

  it('gives different folders different keys', () => {
    expect(sessionRequestPath(dir, '/a')).not.toBe(sessionRequestPath(dir, '/b'))
  })

  it('is stable for the same folder', () => {
    expect(sessionRequestPath(dir, '/a')).toBe(sessionRequestPath(dir, '/a'))
  })
})

describe('isSessionRequestFile', () => {
  it('recognises its own files and nothing else', () => {
    expect(isSessionRequestFile('session-request-abc.json')).toBe(true)
    expect(isSessionRequestFile('window-abc.json')).toBe(false)
    expect(isSessionRequestFile('focus-abc.json')).toBe(false)
  })
})

describe('writeSessionRequest / claimSessionRequest', () => {
  it('round-trips a resume request', () => {
    writeSessionRequest(dir, '/proj', '/proj/sub', 'sess-1', NOW)
    expect(claimSessionRequest(dir, ['/proj'], NOW)).toEqual({
      cwd: '/proj/sub',
      sessionId: 'sess-1',
      timestamp: NOW,
    })
  })

  it('round-trips a new-session request, which carries no id', () => {
    writeSessionRequest(dir, '/proj', '/proj', undefined, NOW)
    const claimed = claimSessionRequest(dir, ['/proj'], NOW)
    expect(claimed?.cwd).toBe('/proj')
    expect(claimed?.sessionId).toBeUndefined()
  })

  it('keys on the claiming folder, not the session cwd', () => {
    // A session can run in a subdirectory of the folder the window has open.
    writeSessionRequest(dir, '/proj', '/proj/deep/nested', 'sess-1', NOW)
    expect(claimSessionRequest(dir, ['/proj'], NOW)?.cwd).toBe('/proj/deep/nested')
  })

  it('can only be claimed once', () => {
    writeSessionRequest(dir, '/proj', '/proj', 'sess-1', NOW)
    expect(claimSessionRequest(dir, ['/proj'], NOW)).toBeDefined()
    expect(claimSessionRequest(dir, ['/proj'], NOW)).toBeUndefined()
  })

  it('ignores a request for a folder this window does not have', () => {
    writeSessionRequest(dir, '/proj', '/proj', 'sess-1', NOW)
    expect(claimSessionRequest(dir, ['/other'], NOW)).toBeUndefined()
  })

  it('tries every folder of a multi-root workspace', () => {
    writeSessionRequest(dir, '/second', '/second', 'sess-1', NOW)
    expect(claimSessionRequest(dir, ['/first', '/second'], NOW)).toBeDefined()
  })

  it('refuses a request older than the TTL', () => {
    writeSessionRequest(dir, '/proj', '/proj', 'sess-1', NOW)
    const late = NOW + REQUEST_TTL_MS + 1
    expect(claimSessionRequest(dir, ['/proj'], late)).toBeUndefined()
  })

  it('accepts a request still inside the TTL', () => {
    writeSessionRequest(dir, '/proj', '/proj', 'sess-1', NOW)
    expect(claimSessionRequest(dir, ['/proj'], NOW + REQUEST_TTL_MS - 1)).toBeDefined()
  })

  it('returns undefined when nothing is pending', () => {
    expect(claimSessionRequest(dir, ['/proj'], NOW)).toBeUndefined()
  })

  it('skips a malformed request rather than throwing', () => {
    fs.writeFileSync(sessionRequestPath(dir, '/proj'), 'not json')
    expect(claimSessionRequest(dir, ['/proj'], NOW)).toBeUndefined()
  })
})

describe('pruneStaleSessionRequests', () => {
  it('removes requests a window never claimed', () => {
    writeSessionRequest(dir, '/proj', '/proj', 'sess-1', NOW)
    pruneStaleSessionRequests(dir, NOW + REQUEST_TTL_MS + 1)
    expect(fs.existsSync(sessionRequestPath(dir, '/proj'))).toBe(false)
  })

  it('leaves a fresh request alone', () => {
    writeSessionRequest(dir, '/proj', '/proj', 'sess-1', NOW)
    pruneStaleSessionRequests(dir, NOW + 1000)
    expect(fs.existsSync(sessionRequestPath(dir, '/proj'))).toBe(true)
  })

  it('never touches other files in the storage directory', () => {
    const other = path.join(dir, 'window-abc.json')
    fs.writeFileSync(other, '{}')
    pruneStaleSessionRequests(dir, NOW + REQUEST_TTL_MS + 1)
    expect(fs.existsSync(other)).toBe(true)
  })

  it('tolerates a missing directory', () => {
    expect(() =>
      pruneStaleSessionRequests(path.join(dir, 'nope'), NOW),
    ).not.toThrow()
  })
})
