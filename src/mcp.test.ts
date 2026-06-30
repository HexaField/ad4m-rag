import { describe, it, expect } from 'vitest'
import { createMcpToolFactory } from './mcp.js'

describe('MCP tool factory', () => {
  it('exposes the documented tools', () => {
    const stub: any = {}
    const factory = createMcpToolFactory({ store: stub, ingest: stub, query: stub })
    const names = factory.tools().map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'knowledge_query',
        'knowledge_get_entity',
        'knowledge_list_communities',
        'knowledge_ingest',
        'knowledge_reextract',
        'knowledge_retract',
        'knowledge_publish',
        'knowledge_unpublish',
        'knowledge_who_asserted'
      ])
    )
  })

  it('every tool has a name, description, JSON schema, and async handler', () => {
    const stub: any = {}
    const factory = createMcpToolFactory({ store: stub, ingest: stub, query: stub })
    for (const t of factory.tools()) {
      expect(typeof t.name).toBe('string')
      expect(typeof t.description).toBe('string')
      expect(typeof t.inputSchema).toBe('object')
      expect(typeof t.handler).toBe('function')
    }
  })

  it('knowledge_query forwards args to query.query', async () => {
    const calls: unknown[] = []
    const query = {
      query: async (req: unknown) => {
        calls.push(req)
        return { answer: 'ok', mode: 'local', citations: [], trace: { retrievalK: 0, llmCalls: 0, durationMs: 0 } }
      }
    }
    const factory = createMcpToolFactory({ store: {} as any, ingest: {} as any, query: query as any })
    const tool = factory.tools().find((t) => t.name === 'knowledge_query')!
    const out = await tool.handler({ question: 'hi', mode: 'global' })
    expect(calls).toHaveLength(1)
    expect((calls[0] as any).question).toBe('hi')
    expect((calls[0] as any).mode).toBe('global')
    expect((out as any).answer).toBe('ok')
  })

  it('knowledge_ingest falls back to defaultAssertedBy when caller omits it', async () => {
    const calls: unknown[] = []
    const ingest = {
      append: async (input: unknown) => {
        calls.push(input)
        return { entitiesExtracted: 0, relationshipsExtracted: 0, claimsExtracted: 0 }
      }
    }
    const factory = createMcpToolFactory({
      store: {} as any,
      ingest: ingest as any,
      query: {} as any,
      defaultAssertedBy: { did: 'did:fallback' }
    })
    const tool = factory.tools().find((t) => t.name === 'knowledge_ingest')!
    await tool.handler({ documentId: 'doc-A', text: 'hello' })
    expect((calls[0] as any).assertedBy.did).toBe('did:fallback')
  })
})
