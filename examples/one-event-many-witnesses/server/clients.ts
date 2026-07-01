// Deterministic, offline clients for the demo.
//
// The library takes pluggable EmbeddingClient / LlmClient seams. In
// production you'd wire Ollama + Anthropic; here we supply deterministic
// stand-ins so the demo runs with no network, no API keys, and identical
// output every time. These are real implementations of the library's
// interfaces — not stubs of the library itself.

import type { EmbeddingClient, LlmClient } from '../../../dist/index.js'

// ── Feature-hashing embedder ────────────────────────────────────────
// A genuine embedding function: hash tokens into a fixed-width vector
// with signed buckets, then L2-normalise. Good enough for the vector
// fallback path; fully deterministic.

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function createFeatureHashEmbedder(dim = 256): EmbeddingClient {
  const embedOne = (text: string): number[] => {
    const v = new Array<number>(dim).fill(0)
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
    for (const t of tokens) {
      const h = fnv1a(t)
      const idx = h % dim
      const sign = (h >>> 31) & 1 ? 1 : -1
      v[idx] += sign
    }
    let norm = 0
    for (const x of v) norm += x * x
    norm = Math.sqrt(norm) || 1
    return v.map((x) => x / norm)
  }
  return {
    async embed(text: string) {
      return embedOne(text)
    },
    async embedBatch(texts: string[]) {
      return texts.map(embedOne)
    },
    dimension() {
      return dim
    }
  }
}

// ── Scripted answer LLM ─────────────────────────────────────────────
// The query engine calls llm.complete() once, in local mode, to
// synthesise an answer from retrieved context. LOCAL_SYSTEM instructs
// the model to answer using ONLY the supplied context — so a
// deterministic extraction of the supplied Claims/Cells is a faithful,
// honest synthesis. Extraction is handled by the scripted extractor
// (see corpus.ts), never by this client.

export function createScriptedLlm(): LlmClient {
  return {
    async complete({ system, user }) {
      if (system && system.includes('You answer questions using ONLY')) {
        return synthesiseFromContext(user)
      }
      // Unused in this demo (extraction is curated), but return valid
      // empty-graph JSON so nothing downstream throws.
      return '{"entities":[],"relationships":[],"claims":[]}'
    }
  }
}

function synthesiseFromContext(context: string): string {
  const question = firstMatch(context, /^Question:\s*(.+)$/m) ?? ''
  const claimsBlock = sliceBlock(context, 'Claims:', ['Evidence:'])
  const statements: string[] = []
  const cellLines: string[] = []
  for (const raw of claimsBlock.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('- about')) {
      const m = line.match(/^- about \[[^\]]*\]:\s*(.+)$/)
      if (m) statements.push(m[1].trim())
    } else if (line.startsWith('·')) {
      cellLines.push(line.replace(/^·\s*/, ''))
    }
  }

  if (statements.length === 0 && cellLines.length === 0) {
    return 'The retrieved context does not contain a claim that answers this question.'
  }

  const objective = cellLines.filter((l) => l.includes('·objective'))
  const subjective = cellLines.filter((l) => l.includes('·subjective'))

  const parts: string[] = []
  if (statements.length > 0) {
    const uniq = [...new Set(statements)]
    parts.push(
      uniq.length === 1
        ? `From the retrieved claims: ${uniq[0]}`
        : `From the retrieved claims: ${uniq.join(' ')}`
    )
  }
  if (objective.length > 0) {
    parts.push(`Objectively, the accounts converge on ${joinCells(objective)}.`)
  }
  if (subjective.length > 0) {
    parts.push(`On the felt/intended side they diverge: ${joinCells(subjective)}.`)
  }
  void question
  return parts.join(' ')
}

function joinCells(cellLines: string[]): string {
  // cellLines look like "who·objective: three residents"
  const bits = cellLines.map((l) => {
    const [cell, filler] = splitFirst(l, ':')
    return `${cell.trim()} = ${filler.trim()}`
  })
  return bits.join('; ')
}

function firstMatch(s: string, re: RegExp): string | null {
  const m = s.match(re)
  return m ? m[1] : null
}

function splitFirst(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep)
  if (i < 0) return [s, '']
  return [s.slice(0, i), s.slice(i + sep.length)]
}

function sliceBlock(text: string, startMarker: string, endMarkers: string[]): string {
  const start = text.indexOf(startMarker)
  if (start < 0) return ''
  const from = start + startMarker.length
  let end = text.length
  for (const m of endMarkers) {
    const i = text.indexOf(m, from)
    if (i >= 0 && i < end) end = i
  }
  return text.slice(from, end)
}
