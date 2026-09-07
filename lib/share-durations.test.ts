import { describe, it, expect } from 'vitest'
import { durationLabel, formatExpiry } from './share-durations'
describe('durationLabel', () => {
  // A Sunday. The 24h and 30d cases below land on a different weekday, so an
  // implementation that read now.getDay() instead of the expiry's would fail
  // them; the 7d case cannot distinguish the two, since any 7-day offset
  // necessarily lands on the same weekday it started from.
  const now = new Date(2026, 8, 6, 15, 4)

  it('names the day a 24-hour link stops working', () => {
    expect(durationLabel('24h', now)).toBe('Mon 7 Sep')
  })

  it('names the day a 7-day link stops working', () => {
    expect(durationLabel('7d', now)).toBe('Sun 13 Sep')
  })

  // Crosses a month boundary, which is where naive day arithmetic breaks.
  it('names the day a 30-day link stops working', () => {
    expect(durationLabel('30d', now)).toBe('Tue 6 Oct')
  })

  it('crosses a year boundary', () => {
    expect(durationLabel('30d', new Date(2026, 11, 20, 9, 0))).toBe('Tue 19 Jan')
  })
})

describe('formatExpiry', () => {
  const at = (y: number, m: number, d: number, h: number, min: number) =>
    Math.floor(new Date(y, m, d, h, min).getTime() / 1000)

  it('reads as a date and a wall-clock time', () => {
    expect(formatExpiry(at(2026, 8, 13, 15, 4))).toBe('Sun 13 Sep, 3:04 PM')
  })

  it('pads the minutes', () => {
    expect(formatExpiry(at(2026, 8, 13, 9, 5))).toBe('Sun 13 Sep, 9:05 AM')
  })

  // 0 and 12 are where 24-to-12 hour conversion goes wrong.
  it('calls midnight 12 AM', () => {
    expect(formatExpiry(at(2026, 8, 13, 0, 0))).toBe('Sun 13 Sep, 12:00 AM')
  })

  it('calls noon 12 PM', () => {
    expect(formatExpiry(at(2026, 8, 13, 12, 0))).toBe('Sun 13 Sep, 12:00 PM')
  })

  it('does not pad the day of the month', () => {
    expect(formatExpiry(at(2026, 8, 3, 8, 30))).toBe('Thu 3 Sep, 8:30 AM')
  })
})
