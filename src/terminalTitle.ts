import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import type { SessionState, ViewModel } from './viewModel.js'

/**
 * Session state in the terminal tab title.
 *
 * VS Code gives extensions no way to retitle or re-icon a terminal once it is
 * open. What it does honour is the title a process sets with an OSC escape
 * sequence, shown when `terminal.integrated.tabs.title` is `${sequence}`. So
 * the extension writes that sequence to the terminal's tty itself, from the
 * state it already tracks — and asks Claude not to set a title of its own
 * (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE`), which would overwrite ours.
 */

const SYMBOL: Partial<Record<SessionState, string>> = {
  running: '🟢',
  attention: '🟠',
  background: '🔵',
  idle: '⚪',
}

/** Cap by code points so an emoji or accent is never cut in half. */
export const truncate = (text: string, max: number): string => {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, Math.max(1, max - 1)).join('') + '…'
}

/** Control characters would end the escape sequence early or inject another. */
const clean = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()

export const formatTerminalTitle = (
  state: SessionState,
  name: string,
  maxLength: number,
): string | undefined => {
  const symbol = SYMBOL[state]
  if (symbol === undefined) return undefined
  return `${symbol} ${truncate(clean(name), maxLength)}`
}

export const titleSequence = (title: string): string => `\u001b]0;${clean(title)}\u0007`

/** `ps` prints `ttys012`, or `??` for a process with no terminal. */
const lookupTty = (pid: number): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile('ps', ['-o', 'tty=', '-p', String(pid)], (error, stdout) => {
      const tty = stdout.trim()
      resolve(error === null && /^[\w/]+$/.test(tty) && tty !== '??' ? tty : undefined)
    })
  })

export interface TerminalTitleTarget {
  /** Shell pid of the terminal the session runs in. */
  readonly pid: number
  /** What to put back once the session is gone. */
  readonly fallback: string
}

export class TerminalTitles {
  private readonly _written = new Map<number, string>()
  private readonly _ttys = new Map<number, Promise<string | undefined>>()
  private readonly _fallbacks = new Map<number, string>()

  constructor(
    private readonly _log: (message: string) => void,
    private readonly _write: (device: string, data: string) => Promise<void> = (device, data) =>
      fs.promises.writeFile(device, data, { flag: 'a' }),
    private readonly _tty: (pid: number) => Promise<string | undefined> = lookupTty,
  ) {}

  /**
   * Bring every local session's tab title in line with the model. Only
   * changes are written: the model is rebuilt on every hook event.
   */
  sync(
    model: ViewModel,
    targetOf: (sessionId: string) => TerminalTitleTarget | undefined,
    maxLength: number,
  ): void {
    const seen = new Set<number>()
    if (maxLength > 0) {
      for (const group of model.active) {
        for (const session of group.live) {
          if (session.remote !== undefined) continue
          const target = targetOf(session.id)
          if (target === undefined) continue
          const title = formatTerminalTitle(session.state, session.title, maxLength)
          if (title === undefined) continue
          seen.add(target.pid)
          this._fallbacks.set(target.pid, target.fallback)
          this._set(target.pid, title)
        }
      }
    }
    // A session that ended would otherwise leave its last state frozen in the tab.
    for (const pid of [...this._written.keys()]) {
      if (seen.has(pid)) continue
      const fallback = this._fallbacks.get(pid) ?? ''
      this._written.delete(pid)
      this._fallbacks.delete(pid)
      void this._send(pid, fallback)
    }
  }

  private _set(pid: number, title: string): void {
    if (this._written.get(pid) === title) return
    this._written.set(pid, title)
    void this._send(pid, title)
  }

  private async _send(pid: number, title: string): Promise<void> {
    let tty = this._ttys.get(pid)
    if (tty === undefined) {
      tty = this._tty(pid)
      this._ttys.set(pid, tty)
    }
    const name = await tty
    if (name === undefined) {
      this._ttys.delete(pid) // Retry next time: the shell may just be starting.
      return
    }
    try {
      await this._write(`/dev/${name}`, titleSequence(title))
    } catch (error) {
      this._ttys.delete(pid)
      this._log(`terminal title write failed for pid ${pid}: ${String(error)}`)
    }
  }
}
