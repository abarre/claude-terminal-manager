import { describe, it, expect } from 'vitest'
import { ageOf, stateTintOf, TINT_COUNT, tintOf, tokensOf } from './format.js'

const NOW = 1_700_000_000_000
const ago = (ms: number): string => ageOf(NOW - ms, NOW)

describe('ageOf', () => {
  it('renders nothing when there is no timestamp', () => {
    expect(ageOf(0, NOW)).toBe('')
  })

  it('renders the first three quarters of a minute as "now"', () => {
    expect(ago(0)).toBe('now')
    expect(ago(44_000)).toBe('now')
  })

  it('switches to minutes once past the "now" window', () => {
    expect(ago(45_000)).toBe('1m')
    expect(ago(5 * 60_000)).toBe('5m')
    expect(ago(59 * 60_000)).toBe('59m')
  })

  it('switches to hours at an hour', () => {
    expect(ago(60 * 60_000)).toBe('1h')
    expect(ago(5 * 3600_000)).toBe('5h')
    expect(ago(23 * 3600_000)).toBe('23h')
  })

  it('switches to days at a day', () => {
    expect(ago(24 * 3600_000)).toBe('1d')
    expect(ago(3 * 86_400_000)).toBe('3d')
  })

  it('never renders a negative age for a clock skewed into the future', () => {
    expect(ageOf(NOW + 60_000, NOW)).toBe('now')
  })
})

describe('tokensOf', () => {
  it('renders nothing for a session that has not spent any', () => {
    expect(tokensOf(0)).toBe('')
  })

  it('floors the first thousand rather than rendering "0k"', () => {
    expect(tokensOf(1)).toBe('<1k')
    expect(tokensOf(999)).toBe('<1k')
  })

  it('rounds to thousands', () => {
    expect(tokensOf(1000)).toBe('1k')
    expect(tokensOf(58_202)).toBe('58k')
    expect(tokensOf(399_600)).toBe('400k')
  })

  it('switches to millions before "1000k" can appear', () => {
    expect(tokensOf(999_400)).toBe('999k')
    expect(tokensOf(999_500)).toBe('1.0M')
    expect(tokensOf(1_240_000)).toBe('1.2M')
  })
})

describe('tintOf', () => {
  it('gives a label the same tint every time', () => {
    expect(tintOf('fstrz')).toBe(tintOf('fstrz'))
  })

  it('stays inside the palette the stylesheet defines', () => {
    for (const name of ['a', 'fstrz', 'claude-terminal-manager', '', 'In Review']) {
      expect(tintOf(name)).toBeGreaterThanOrEqual(0)
      expect(tintOf(name)).toBeLessThan(TINT_COUNT)
    }
  })

  it('spreads labels over the whole palette instead of crowding a few slots', () => {
    const labels = Array.from({ length: 120 }, (_, i) => `state-${i}`)
    expect(new Set(labels.map(tintOf)).size).toBe(TINT_COUNT)
  })

  it('gives labels one character apart different tints', () => {
    expect(tintOf('fstrz')).not.toBe(tintOf('fstrs'))
  })
})

describe('stateTintOf', () => {
  const tint = (state: string): number => stateTintOf(state)

  it('keeps a workflow apart, stage by stage', () => {
    const states = [
      'Ready for Development',
      'Blocked',
      'In Development',
      'Ready for Review',
      'Ready for Test',
      'Ready for Deploy',
      'Deployed in production',
      'Completed',
    ]
    expect(new Set(states.map(tint)).size).toBe(states.length)
  })

  it('reads a state for what it is, not for the word it opens with', () => {
    expect(tint('Ready for Review')).toBe(tint('In Review'))
    expect(tint('Ready for Test')).toBe(tint('Testing'))
    expect(tint('Deployed in production')).not.toBe(tint('Ready for Deploy'))
  })

  it('does not care about case or language', () => {
    expect(tint('BLOQUÉ')).toBe(tint('blocked'))
    expect(tint('Terminé')).toBe(tint('Done'))
  })

  it('falls back to the hash for a state it does not know', () => {
    expect(tint('Groomed')).toBe(tintOf('Groomed'))
  })

  it('stays inside the palette', () => {
    for (const state of ['Blocked', 'Groomed', '', 'Ready for Deploy']) {
      expect(tint(state)).toBeGreaterThanOrEqual(0)
      expect(tint(state)).toBeLessThan(TINT_COUNT)
    }
  })
})
