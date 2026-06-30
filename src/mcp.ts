// Optional MCP tool factory. We return a schema-shaped object the host
// can register with whichever MCP runtime it uses. No runtime dep on any
// MCP SDK.

import type { IngestApi } from './ingest/pipeline.js'
import type { QueryEngine } from './query/index.js'
import type { KnowledgeGraphStore } from './store.js'

/** A single tool the host registers with its MCP server. */
export interface McpTool {
  name: string
  description: string
  /** JSON Schema for the input arguments. */
  inputSchema: Record<string, unknown>
  /** Invoke the tool with parsed/validated args. Returns a JSON-serialisable result. */
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export interface McpToolFactory {
  tools(): McpTool[]
}

export interface McpToolDeps {
  store: KnowledgeGraphStore
  ingest: IngestApi
  query: QueryEngine
  /** Default AgentRef applied to `knowledge_ingest` if the agent omits it. */
  defaultAssertedBy?: { did: string; label?: string }
}

export function createMcpToolFactory(deps: McpToolDeps): McpToolFactory {
  return {
    tools(): McpTool[] {
      return [
        {
          name: 'knowledge_query',
          description:
            'Run a query against the knowledge graph. Mode "local" walks entities; "global" maps over community summaries; "auto" picks based on question shape.',
          inputSchema: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              mode: { type: 'string', enum: ['local', 'global', 'auto'] },
              fromAgents: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { did: { type: 'string' }, label: { type: 'string' } },
                  required: ['did']
                }
              },
              fromPerspectives: { type: 'array', items: { type: 'string' } },
              maxTokens: { type: 'integer', minimum: 1 }
            },
            required: ['question']
          },
          handler: async (args) => {
            const question = String(args.question)
            const mode = args.mode as 'local' | 'global' | 'auto' | undefined
            const fromAgents = Array.isArray(args.fromAgents)
              ? (args.fromAgents as Array<{ did: string; label?: string }>)
              : undefined
            const fromPerspectives = Array.isArray(args.fromPerspectives)
              ? (args.fromPerspectives as string[])
              : undefined
            const maxTokens = typeof args.maxTokens === 'number' ? args.maxTokens : undefined
            return await deps.query.query({ question, mode, fromAgents, fromPerspectives, maxTokens })
          }
        },
        {
          name: 'knowledge_get_entity',
          description: 'Fetch an entity by URI.',
          inputSchema: {
            type: 'object',
            properties: { uri: { type: 'string' } },
            required: ['uri']
          },
          handler: async (args) => deps.store.getEntity(String(args.uri))
        },
        {
          name: 'knowledge_list_communities',
          description: 'List communities, optionally filtered to a hierarchy level.',
          inputSchema: {
            type: 'object',
            properties: { level: { type: 'integer', minimum: 0 } }
          },
          handler: async (args) => {
            const level = typeof args.level === 'number' ? args.level : undefined
            return await deps.store.listCommunities(level)
          }
        },
        {
          name: 'knowledge_ingest',
          description:
            'Ingest a document into the knowledge graph. The text is chunked, extracted, and embedded.',
          inputSchema: {
            type: 'object',
            properties: {
              documentId: { type: 'string' },
              text: { type: 'string' },
              metadata: { type: 'object' },
              assertedBy: {
                type: 'object',
                properties: { did: { type: 'string' }, label: { type: 'string' } },
                required: ['did']
              }
            },
            required: ['documentId', 'text']
          },
          handler: async (args) => {
            const assertedBy =
              (args.assertedBy as { did: string; label?: string } | undefined) ??
              deps.defaultAssertedBy ?? { did: 'did:unknown:mcp-default' }
            return await deps.ingest.append({
              documentId: String(args.documentId),
              text: String(args.text),
              metadata: args.metadata as Record<string, unknown> | undefined,
              assertedBy
            })
          }
        },
        {
          name: 'knowledge_reextract',
          description:
            'Force-reprocess a previously ingested document. Invalidates the extraction cache for its chunks.',
          inputSchema: {
            type: 'object',
            properties: { documentId: { type: 'string' } },
            required: ['documentId']
          },
          handler: async (args) => {
            await deps.ingest.reextract(String(args.documentId))
            return { ok: true }
          }
        },
        {
          name: 'knowledge_retract',
          description: 'Remove a previously ingested document and any extractions whose only support was it.',
          inputSchema: {
            type: 'object',
            properties: { documentId: { type: 'string' } },
            required: ['documentId']
          },
          handler: async (args) => {
            await deps.ingest.retract(String(args.documentId))
            return { ok: true }
          }
        },
        {
          name: 'knowledge_publish',
          description:
            'Promote a subject (entity, relationship, claim, community) into a named AD4M perspective. The local private copy is unaffected.',
          inputSchema: {
            type: 'object',
            properties: {
              uri: { type: 'string' },
              perspectiveUuid: { type: 'string' }
            },
            required: ['uri', 'perspectiveUuid']
          },
          handler: async (args) => {
            await deps.store.publishToPerspective(String(args.uri), String(args.perspectiveUuid))
            return { ok: true }
          }
        },
        {
          name: 'knowledge_unpublish',
          description: 'Demote a subject from a named AD4M perspective. The local copy is unaffected.',
          inputSchema: {
            type: 'object',
            properties: {
              uri: { type: 'string' },
              perspectiveUuid: { type: 'string' }
            },
            required: ['uri', 'perspectiveUuid']
          },
          handler: async (args) => {
            await deps.store.unpublishFromPerspective(String(args.uri), String(args.perspectiveUuid))
            return { ok: true }
          }
        },
        {
          name: 'knowledge_who_asserted',
          description: 'Return the list of agents (AgentRef[]) who have asserted a given subject.',
          inputSchema: {
            type: 'object',
            properties: { uri: { type: 'string' } },
            required: ['uri']
          },
          handler: async (args) => {
            const uri = String(args.uri)
            const e = await deps.store.getEntity(uri)
            if (e) return { assertedBy: e.assertedBy }
            const c = await deps.store.getClaim(uri)
            if (c) return { assertedBy: c.assertedBy }
            return { assertedBy: [] }
          }
        }
      ]
    }
  }
}
