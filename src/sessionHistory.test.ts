import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  clearHistoryTitleCache,
  decodeProjectFolder,
  encodeProjectFolder,
  findSessionCwd,
  readSessionHistory,
} from './sessionHistory.js'

let tmp: string

const mkdirp = (p: string): void => {
  fs.mkdirSync(p, { recursive: true })
}

const writeSession = (
  root: string,
  folder: string,
  id: string,
  lines: string[],
  mtimeMs?: number,
): string => {
  const dir = path.join(root, folder)
  mkdirp(dir)
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, lines.join('\n'))
  if (mtimeMs !== undefined) {
    const t = mtimeMs / 1000
    fs.utimesSync(file, t, t)
  }
  return file
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-history-'))
  clearHistoryTitleCache()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('encodeProjectFolder', () => {
  it('replaces every separator with a dash', () => {
    expect(encodeProjectFolder('/home/me/fstrz')).toBe('-home-me-fstrz')
  })
})

describe('decodeProjectFolder', () => {
  it('resolves from a known candidate without touching the filesystem', () => {
    const cwd = '/definitely/not/on/disk/anywhere'
    expect(decodeProjectFolder(encodeProjectFolder(cwd), [cwd])).toBe(cwd)
  })

  it('recovers a path whose final segment contains dashes', () => {
    const real = path.join(tmp, 'me', 'claude-terminal-manager')
    mkdirp(real)
    expect(decodeProjectFolder(encodeProjectFolder(real))).toBe(real)
  })

  it('recovers a path with dashes in an intermediate segment', () => {
    const real = path.join(tmp, 'my-org', 'my-repo', 'sub')
    mkdirp(real)
    expect(decodeProjectFolder(encodeProjectFolder(real))).toBe(real)
  })

  it('does not mistake a dashed name for nested directories', () => {
    // Both /tmp/x/a-b and /tmp/x/a/b exist; the encoded form is ambiguous.
    // Whichever it picks must be a directory that actually exists.
    const dashed = path.join(tmp, 'x', 'a-b')
    const nested = path.join(tmp, 'x', 'a', 'b')
    mkdirp(dashed)
    mkdirp(nested)
    const decoded = decodeProjectFolder(encodeProjectFolder(dashed))
    expect(decoded).toBeDefined()
    expect(fs.existsSync(decoded!)).toBe(true)
  })

  it('prefers a candidate over an ambiguous filesystem match', () => {
    const dashed = path.join(tmp, 'x', 'a-b')
    const nested = path.join(tmp, 'x', 'a', 'b')
    mkdirp(dashed)
    mkdirp(nested)
    expect(decodeProjectFolder(encodeProjectFolder(nested), [nested])).toBe(
      nested,
    )
  })

  it('returns undefined when nothing on disk matches', () => {
    expect(
      decodeProjectFolder('-no-such-directory-anywhere-at-all-really'),
    ).toBeUndefined()
  })

  it('returns undefined for a relative-looking folder name', () => {
    expect(decodeProjectFolder('not-absolute')).toBeUndefined()
  })
})

describe('readSessionHistory', () => {
  const now = 1_700_000_000_000

  it('returns nothing when the window is zero', async () => {
    const entries = await readSessionHistory({
      hours: 0,
      now,
      knownCwds: [],
      root: tmp,
    })
    expect(entries).toEqual([])
  })

  it('returns nothing when the projects root is missing', async () => {
    const entries = await readSessionHistory({
      hours: 24,
      now,
      knownCwds: [],
      root: path.join(tmp, 'nope'),
    })
    expect(entries).toEqual([])
  })

  it('lists sessions inside the window and excludes older ones', async () => {
    const cwd = '/home/me/fstrz'
    const folder = encodeProjectFolder(cwd)
    writeSession(tmp, folder, 'recent', ['{}'], now - 2 * 3600_000)
    writeSession(tmp, folder, 'stale', ['{}'], now - 48 * 3600_000)

    const entries = await readSessionHistory({
      hours: 24,
      now,
      knownCwds: [cwd],
      root: tmp,
    })
    expect(entries.map((e) => e.id)).toEqual(['recent'])
    expect(entries[0]!.cwd).toBe(cwd)
  })

  it('sorts most recent first', async () => {
    const cwd = '/home/me/fstrz'
    const folder = encodeProjectFolder(cwd)
    writeSession(tmp, folder, 'older', ['{}'], now - 5 * 3600_000)
    writeSession(tmp, folder, 'newer', ['{}'], now - 1 * 3600_000)

    const entries = await readSessionHistory({
      hours: 24,
      now,
      knownCwds: [cwd],
      root: tmp,
    })
    expect(entries.map((e) => e.id)).toEqual(['newer', 'older'])
  })

  it('reads the custom title from the transcript', async () => {
    const cwd = '/home/me/fstrz'
    writeSession(
      tmp,
      encodeProjectFolder(cwd),
      'titled',
      [
        JSON.stringify({ slug: 'auto-generated-slug' }),
        JSON.stringify({ type: 'custom-title', customTitle: 'My real title' }),
      ],
      now - 3600_000,
    )
    const entries = await readSessionHistory({
      hours: 24,
      now,
      knownCwds: [cwd],
      root: tmp,
    })
    expect(entries[0]!.title).toBe('My real title')
  })

  it('falls back to the slug when there is no custom title', async () => {
    const cwd = '/home/me/fstrz'
    writeSession(
      tmp,
      encodeProjectFolder(cwd),
      'slugged',
      [JSON.stringify({ slug: 'wandering-teal-otter' })],
      now - 3600_000,
    )
    const entries = await readSessionHistory({
      hours: 24,
      now,
      knownCwds: [cwd],
      root: tmp,
    })
    expect(entries[0]!.title).toBe('wandering-teal-otter')
  })

  it('skips folders whose path cannot be resolved', async () => {
    writeSession(tmp, '-gone-missing-entirely', 'x', ['{}'], now - 3600_000)
    const entries = await readSessionHistory({
      hours: 24,
      now,
      knownCwds: [],
      root: tmp,
    })
    expect(entries).toEqual([])
  })

  it('ignores non-jsonl files', async () => {
    const cwd = '/home/me/fstrz'
    const dir = path.join(tmp, encodeProjectFolder(cwd))
    mkdirp(dir)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello')
    const entries = await readSessionHistory({
      hours: 24,
      now,
      knownCwds: [cwd],
      root: tmp,
    })
    expect(entries).toEqual([])
  })
})

describe('findSessionCwd', () => {
  it('locates the folder holding the transcript', () => {
    const cwd = '/home/me/fstrz'
    writeSession(tmp, encodeProjectFolder(cwd), 'abc', ['{}'])
    expect(findSessionCwd('abc', [cwd], tmp)).toBe(cwd)
  })

  it('returns undefined for an unknown session', () => {
    expect(findSessionCwd('nope', [], tmp)).toBeUndefined()
  })

  it('resolves a dashed project path from disk', () => {
    const real = path.join(tmp, 'repos', 'claude-terminal-manager')
    mkdirp(real)
    writeSession(tmp, encodeProjectFolder(real), 'sess', ['{}'])
    expect(findSessionCwd('sess', [], tmp)).toBe(real)
  })
})
