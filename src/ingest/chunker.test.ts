import { describe, it, expect } from 'vitest'
import { chunkText } from './chunker.js'

describe('chunkText', () => {
  it('returns a single chunk when the input is shorter than the chunk size', () => {
    const text = 'short.'
    const out = chunkText(text, { chunkSize: 100 })
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe(text)
    expect(out[0].start).toBe(0)
    expect(out[0].end).toBe(text.length)
  })

  it('emits overlapping chunks for long input', () => {
    const text = 'a'.repeat(2500)
    const out = chunkText(text, { chunkSize: 1000, overlap: 200, respectWordBoundaries: false })
    expect(out.length).toBeGreaterThan(1)
    expect(out[0].text.length).toBe(1000)
    // Adjacent chunks overlap by `overlap`.
    expect(out[1].start).toBe(800)
    expect(out[0].end - out[1].start).toBe(200)
  })

  it('respects word boundaries when asked', () => {
    const text = 'one '.repeat(500) // each token "one " is 4 chars; 2000 total
    const out = chunkText(text, { chunkSize: 1000, overlap: 200, respectWordBoundaries: true })
    expect(out.length).toBeGreaterThan(1)
    // Each chunk should end on a whitespace boundary.
    for (const c of out.slice(0, -1)) {
      expect(/\s$/.test(c.text) || c.end === text.length).toBe(true)
    }
  })

  it('returns empty for empty input', () => {
    expect(chunkText('')).toEqual([])
  })
})
