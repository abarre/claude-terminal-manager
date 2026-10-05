import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Resolve a cwd to the folder of the repository it belongs to, following a
 * linked worktree back to its main checkout. Without this, a worktree under
 * `repo/.claude/worktrees/<name>` or `../repo-feature` gets a project group of
 * its own instead of joining `repo`.
 *
 * Returns undefined when the cwd is not inside a git repository.
 */
export const resolveRepoRoot = (cwd: string): string | undefined => {
  let dir = path.resolve(cwd)
  for (;;) {
    const dotGit = path.join(dir, '.git')
    let stat: fs.Stats | undefined
    try {
      stat = fs.statSync(dotGit)
    } catch {
      stat = undefined
    }
    if (stat?.isDirectory() === true) return dir
    if (stat?.isFile() === true) return mainCheckoutOf(dotGit) ?? dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * A worktree's `.git` file reads `gitdir: <main>/.git/worktrees/<name>`.
 * Submodules use the same file format but point into `.git/modules/`, and
 * should stay their own project — hence the `worktrees` check.
 */
const mainCheckoutOf = (dotGitFile: string): string | undefined => {
  let content: string
  try {
    content = fs.readFileSync(dotGitFile, 'utf8')
  } catch {
    return undefined
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content)
  if (match === null) return undefined
  const gitdir = path.resolve(path.dirname(dotGitFile), match[1]!.trim())
  const worktrees = path.dirname(gitdir)
  if (path.basename(worktrees) !== 'worktrees') return undefined
  const commonDir = path.dirname(worktrees)
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : undefined
}

/**
 * The panel rebuilds on every push, so lookups are memoised. A cwd's repo does
 * not change while a session lives in it.
 */
export const createRepoRootCache = (): ((cwd: string) => string | undefined) => {
  const cache = new Map<string, string | undefined>()
  return (cwd) => {
    if (cache.has(cwd)) return cache.get(cwd)
    const root = resolveRepoRoot(cwd)
    cache.set(cwd, root)
    return root
  }
}
