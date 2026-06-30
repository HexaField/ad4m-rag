// Embedding client interface + default Ollama implementation.

export interface EmbeddingClient {
  /** Embed a single string. Returns a fixed-dim float vector. */
  embed(text: string): Promise<number[]>
  /** Embed many strings in one call. Returns one vector per input. */
  embedBatch(texts: string[]): Promise<number[][]>
  /** The dimension of vectors this client produces. Used to size the sqlite-vec tables. */
  dimension(): number
}

export interface OllamaEmbeddingOptions {
  /** Base URL of the Ollama server. */
  url?: string
  /** Model name. Default: nomic-embed-text. */
  model?: string
  /** Expected output dimension. Default: 768 (nomic-embed-text). */
  dimension?: number
}

/**
 * Default Ollama-backed embedding client. Talks to `/api/embeddings`. The
 * caller is responsible for ensuring Ollama is running and the model is
 * pulled (`ollama pull nomic-embed-text`).
 */
export function createOllamaEmbeddingClient(opts: OllamaEmbeddingOptions = {}): EmbeddingClient {
  const url = (opts.url ?? 'http://localhost:11434').replace(/\/$/, '')
  const model = opts.model ?? 'nomic-embed-text'
  const dim = opts.dimension ?? 768

  async function embedOne(text: string): Promise<number[]> {
    const res = await fetch(`${url}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text })
    })
    if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { embedding?: number[] }
    if (!data.embedding) throw new Error('ollama embed returned no embedding')
    if (data.embedding.length !== dim) {
      throw new Error(
        `ollama embed dimension mismatch: got ${data.embedding.length}, expected ${dim} (model: ${model})`
      )
    }
    return data.embedding
  }

  return {
    embed: embedOne,
    async embedBatch(texts) {
      // Ollama doesn't yet support batched embeddings on /api/embeddings.
      // Issue one request per input with light concurrency.
      const CONCURRENCY = 4
      const out: number[][] = new Array(texts.length)
      let next = 0
      async function worker() {
        while (true) {
          const i = next++
          if (i >= texts.length) return
          out[i] = await embedOne(texts[i])
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker))
      return out
    },
    dimension: () => dim
  }
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: dim mismatch (${a.length} vs ${b.length})`)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
