import { describe, it, expect } from 'vitest'
import { classifyQueryMode } from './classify.js'

describe('classifyQueryMode', () => {
  it('picks global for "what are the themes"', () => {
    expect(classifyQueryMode('What are the themes across this corpus?')).toBe('global')
  })
  it('picks global for "summarise"', () => {
    expect(classifyQueryMode('Summarise the overall structure.')).toBe('global')
  })
  it('picks local for "who is X"', () => {
    expect(classifyQueryMode('Who is Josh Field?')).toBe('local')
  })
  it('picks local for "when did X happen"', () => {
    expect(classifyQueryMode('When did the Sovereign project start?')).toBe('local')
  })
  it('defaults to local for unstructured short prompts', () => {
    expect(classifyQueryMode('AD4M perspectives')).toBe('local')
  })
})
