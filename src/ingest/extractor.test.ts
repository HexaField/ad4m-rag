import { describe, it, expect } from 'vitest'
import { parseExtractionResponse, parseExtractedCells } from './extractor.js'

describe('parseExtractionResponse', () => {
  it('parses a well-formed JSON response', () => {
    const raw = JSON.stringify({
      entities: [{ type: 'Person', name: 'Josh', description: 'A human.' }],
      relationships: [
        {
          source: { type: 'Person', name: 'Josh' },
          predicate: 'works_on',
          target: { type: 'Project', name: 'Sovereign' },
          description: 'Josh is building Sovereign.',
          weight: 0.7
        }
      ],
      claims: [
        {
          about: { type: 'Project', name: 'Sovereign' },
          statement: 'Sovereign uses event buses.',
          cells: [
            { cell: 'what·objective', filler: 'uses event buses' },
            { cell: 'how·objective', filler: 'pub/sub topic routing' }
          ]
        }
      ]
    })
    const r = parseExtractionResponse(raw)
    expect(r.entities).toHaveLength(1)
    expect(r.relationships).toHaveLength(1)
    expect(r.claims).toHaveLength(1)
    expect(r.entities[0].name).toBe('Josh')
    expect(r.relationships[0].weight).toBe(0.7)
    expect(r.claims[0].cells).toHaveLength(2)
    expect(r.claims[0].cells[0].cell).toBe('what·objective')
  })

  it('strips Markdown code fences', () => {
    const raw = '```json\n{"entities":[],"relationships":[],"claims":[]}\n```'
    const r = parseExtractionResponse(raw)
    expect(r.entities).toEqual([])
  })

  it('tolerates surrounding prose', () => {
    const raw = 'Here is the result:\n{"entities":[],"relationships":[],"claims":[]}\nThat is all.'
    const r = parseExtractionResponse(raw)
    expect(r.entities).toEqual([])
  })

  it('defaults missing weight to 0.5', () => {
    const raw = JSON.stringify({
      entities: [],
      relationships: [
        {
          source: { type: 'A', name: 'x' },
          predicate: 'p',
          target: { type: 'A', name: 'y' },
          description: ''
        }
      ],
      claims: []
    })
    const r = parseExtractionResponse(raw)
    expect(r.relationships[0].weight).toBe(0.5)
  })

  it('clamps weight to [0, 1]', () => {
    const raw = JSON.stringify({
      entities: [],
      relationships: [
        {
          source: { type: 'A', name: 'x' },
          predicate: 'p',
          target: { type: 'A', name: 'y' },
          description: '',
          weight: 5
        }
      ],
      claims: []
    })
    const r = parseExtractionResponse(raw)
    expect(r.relationships[0].weight).toBe(1)
  })

  it('drops malformed records', () => {
    const raw = JSON.stringify({
      entities: [{ type: 'A' }, { type: 'B', name: 'b', description: 'd' }],
      relationships: [{ source: { type: 'A', name: 'x' }, predicate: 'p' /* no target */ }],
      claims: []
    })
    const r = parseExtractionResponse(raw)
    expect(r.entities).toHaveLength(1)
    expect(r.relationships).toHaveLength(0)
  })

  it('throws on input without any JSON object', () => {
    expect(() => parseExtractionResponse('no json here')).toThrow()
  })

  it('defaults claim.cells to empty when the LLM omits it', () => {
    const raw = JSON.stringify({
      entities: [],
      relationships: [],
      claims: [{ about: { type: 'P', name: 'x' }, statement: 's' }]
    })
    const r = parseExtractionResponse(raw)
    expect(r.claims[0].cells).toEqual([])
  })

  it('drops cells with unknown cell ids or missing fillers', () => {
    const cells = parseExtractedCells([
      { cell: 'who·objective', filler: 'Josh' },
      { cell: 'who·unknown', filler: 'noise' },
      { cell: 'why·subjective' }, // no filler
      { cell: 'what·objective', filler: '' } // empty filler
    ])
    expect(cells).toHaveLength(1)
    expect(cells[0].cell).toBe('who·objective')
  })
})
