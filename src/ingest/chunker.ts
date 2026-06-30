// Fixed-size overlapping text chunker. The interface returns slices with
// {start, end} offsets so chunks can be located back in the source
// document. Tokens are counted approximately (chars/4) — good enough for
// chunk sizing; the LLM does its own tokenisation downstream.

export interface ChunkerOptions {
  /** Target chunk size, in characters. Default ~1200 (≈300 tokens). */
  chunkSize?: number
  /** Overlap between adjacent chunks, in characters. Default ~200. */
  overlap?: number
  /** Don't split inside a word; back off to the previous whitespace. Default true. */
  respectWordBoundaries?: boolean
}

export interface ChunkSlice {
  text: string
  start: number
  end: number
}

export function chunkText(text: string, opts: ChunkerOptions = {}): ChunkSlice[] {
  const chunkSize = opts.chunkSize ?? 1200
  const overlap = Math.min(opts.overlap ?? 200, chunkSize - 1)
  const respect = opts.respectWordBoundaries ?? true

  if (!text || text.length === 0) return []
  if (text.length <= chunkSize) {
    return [{ text, start: 0, end: text.length }]
  }

  const out: ChunkSlice[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + chunkSize, text.length)
    if (respect && end < text.length) {
      // Back up to the last whitespace before `end` (but not earlier than `cursor + chunkSize/2`).
      const minEnd = cursor + Math.floor(chunkSize / 2)
      for (let i = end; i > minEnd; i--) {
        if (/\s/.test(text[i - 1])) {
          end = i
          break
        }
      }
    }
    out.push({ text: text.slice(cursor, end), start: cursor, end })
    if (end >= text.length) break
    cursor = end - overlap
  }
  return out
}
