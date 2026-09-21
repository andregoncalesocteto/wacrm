import { describe, it, expect } from 'vitest'
import { formatRelative } from './trigger-meta'

const t = (key: string) => key

describe('formatRelative absolute-date branch', () => {
  const old = '2026-01-05T12:00:00Z'

  it('renders numeric dd/mm/yyyy in pt', () => {
    expect(formatRelative(old, t, 'pt')).toBe('05/01/2026')
  })

  it('keeps the historical numeric en output', () => {
    expect(formatRelative(old, t, 'en')).toBe('1/5/2026')
    expect(formatRelative(old, t)).toBe('1/5/2026')
  })
})
