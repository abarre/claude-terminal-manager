import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveRepoRoot } from './repoRoot.js'

describe('resolveRepoRoot', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-')))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const mkdir = (...parts: string[]): string => {
    const dir = path.join(tmp, ...parts)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  it('returns the checkout holding a .git directory', () => {
    const repo = mkdir('fstrz')
    mkdir('fstrz', '.git')
    expect(resolveRepoRoot(mkdir('fstrz', 'roles', 'nginx'))).toBe(repo)
  })

  it('follows a linked worktree back to its main checkout', () => {
    const repo = mkdir('fstrz')
    mkdir('fstrz', '.git', 'worktrees', 'sc-1')
    const wt = mkdir('fstrz', '.claude', 'worktrees', 'sc-1')
    fs.writeFileSync(
      path.join(wt, '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'sc-1')}\n`,
    )
    expect(resolveRepoRoot(wt)).toBe(repo)
  })

  it('keeps a submodule as its own project', () => {
    mkdir('parent', '.git', 'modules', 'sub')
    const sub = mkdir('parent', 'sub')
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n')
    expect(resolveRepoRoot(sub)).toBe(sub)
  })

  it('returns undefined outside any repository', () => {
    expect(resolveRepoRoot(mkdir('plain'))).toBeUndefined()
  })
})
