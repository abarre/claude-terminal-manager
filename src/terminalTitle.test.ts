import { describe, it, expect, vi } from 'vitest'
import {
  TerminalTitles,
  formatTerminalTitle,
  titleSequence,
  truncate,
} from './terminalTitle.js'
import type { SessionState, ViewModel } from './viewModel.js'

const modelWith = (
  sessions: ReadonlyArray<{ id: string; title: string; state: SessionState; remote?: boolean }>,
): ViewModel =>
  ({
    active: [
      {
        live: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          state: s.state,
          remote: s.remote === true ? {} : undefined,
        })),
      },
    ],
    recent: [],
    tickets: [],
    ticketsAvailable: false,
    attentionCount: 0,
  }) as unknown as ViewModel

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const setup = () => {
  const write = vi.fn((_device: string, _data: string) => Promise.resolve())
  const titles = new TerminalTitles(() => {}, write, () => Promise.resolve('ttys007'))
  const target = (id: string) => (id === 'a' ? { pid: 42, fallback: 'claude' } : undefined)
  return { write, titles, target }
}

describe('truncate', () => {
  it('leaves a short name alone', () => {
    expect(truncate('fix login', 30)).toBe('fix login')
  })

  it('cuts a long name to the cap, ellipsis included', () => {
    const out = truncate('expose origin TTFB in Server-Timing header', 20)
    expect([...out]).toHaveLength(20)
    expect(out.endsWith('…')).toBe(true)
  })

  it('never splits an emoji', () => {
    expect(truncate('🚀🚀🚀🚀', 3)).toBe('🚀🚀…')
  })
})

describe('formatTerminalTitle', () => {
  it('prefixes the state symbol', () => {
    expect(formatTerminalTitle('running', 'fix login', 30)).toBe('🟢 fix login')
    expect(formatTerminalTitle('attention', 'fix login', 30)).toBe('🟠 fix login')
  })

  it('has no title for an ended session', () => {
    expect(formatTerminalTitle('ended', 'fix login', 30)).toBeUndefined()
  })

  it('strips control characters that would break out of the sequence', () => {
    expect(formatTerminalTitle('idle', 'a\u0007b\u001b]0;evil', 30)).toBe('⚪ a b ]0;evil')
  })
})

describe('titleSequence', () => {
  it('wraps the title in an OSC 0 sequence', () => {
    expect(titleSequence('🟢 x')).toBe('\u001b]0;🟢 x\u0007')
  })
})

describe('TerminalTitles', () => {
  it('writes the title to the session terminal tty', async () => {
    const { write, titles, target } = setup()
    titles.sync(modelWith([{ id: 'a', title: 'fix login', state: 'running' }]), target, 30)
    await flush()
    expect(write).toHaveBeenCalledWith('/dev/ttys007', '\u001b]0;🟢 fix login\u0007')
  })

  it('writes only when the title changes', async () => {
    const { write, titles, target } = setup()
    const model = modelWith([{ id: 'a', title: 'fix login', state: 'running' }])
    titles.sync(model, target, 30)
    titles.sync(model, target, 30)
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
    titles.sync(modelWith([{ id: 'a', title: 'fix login', state: 'idle' }]), target, 30)
    await flush()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('skips sessions from other windows', async () => {
    const { write, titles } = setup()
    const everywhere = () => ({ pid: 42, fallback: 'claude' })
    titles.sync(
      modelWith([{ id: 'a', title: 'x', state: 'running', remote: true }]),
      everywhere,
      30,
    )
    await flush()
    expect(write).not.toHaveBeenCalled()
  })

  it('restores the terminal name once the session is gone', async () => {
    const { write, titles, target } = setup()
    titles.sync(modelWith([{ id: 'a', title: 'fix login', state: 'running' }]), target, 30)
    titles.sync(modelWith([]), target, 30)
    await flush()
    expect(write).toHaveBeenLastCalledWith('/dev/ttys007', '\u001b]0;claude\u0007')
  })

  it('restores titles when the feature is switched off', async () => {
    const { write, titles, target } = setup()
    titles.sync(modelWith([{ id: 'a', title: 'fix login', state: 'running' }]), target, 30)
    titles.sync(modelWith([{ id: 'a', title: 'fix login', state: 'running' }]), target, 0)
    await flush()
    expect(write).toHaveBeenLastCalledWith('/dev/ttys007', '\u001b]0;claude\u0007')
  })
})
