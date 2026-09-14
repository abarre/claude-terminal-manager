import { describe, it, expect } from 'vitest'
import { ageOf } from './format.js'

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
