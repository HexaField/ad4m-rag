// The demo corpus: one neutral event, three witnesses.
//
// A fig tree is planted in a shared courtyard. Three residents each give
// an account. The *objective* cells they report are identical, so the
// library's content-hash identity merges them into one claim asserted by
// all three (convergence). The *subjective* cells differ, so they stay as
// three separate single-witness claims (divergence). No witness records a
// why·objective — that cell stays empty on purpose. It's the punchline:
// everyone agrees WHAT happened; the WHY lives entirely in the subjective
// column.
//
// Extraction is curated (not LLM-driven) so the demo is deterministic.
// These ExtractionResult objects are exactly what a well-behaved
// extraction prompt would emit — the same shape the real extractor
// produces — fed through the library's real ingest pipeline.

import type { ExtractedClaim, ExtractionResult } from '../../../dist/index.js'

export interface Witness {
  id: string
  label: string
  did: string
  /** The first-person account this witness contributes to the graph. */
  account: string
}

export const EVENT = {
  title: 'One event, many witnesses',
  headline: 'A fig tree was planted in the courtyard.',
  blurb:
    'Three residents each described the same planting. Watch what the twelve cells do: the objective row converges to a single shared claim; the subjective row stays plural. Nobody recorded an objective "why".'
}

const EVENT_ENTITY = { type: 'Event', name: 'Courtyard fig-tree planting' }
const EVENT_DESCRIPTION = 'The planting of a fig tree in a shared courtyard, recounted by three residents.'

// The claim every witness reports identically — same `about`, same
// `statement`, same objective cells. Identity hashing collapses the three
// copies into one claim whose `assertedBy` accumulates all three DIDs.
const SHARED_OBJECTIVE_CLAIM: ExtractedClaim = {
  about: EVENT_ENTITY,
  statement: 'A fig tree was planted in the courtyard on Saturday morning.',
  cells: [
    { cell: 'who·objective', filler: 'three residents' },
    { cell: 'what·objective', filler: 'a fig tree' },
    { cell: 'when·objective', filler: 'Saturday morning' },
    { cell: 'where·objective', filler: 'the courtyard' },
    { cell: 'how·objective', filler: 'dug a pit and backfilled with compost' }
    // NOTE: no why·objective — deliberately empty across all witnesses.
  ]
}

function witnessExtraction(w: { label: string; subjective: ExtractedClaim }): ExtractionResult {
  return {
    entities: [
      { type: EVENT_ENTITY.type, name: EVENT_ENTITY.name, description: EVENT_DESCRIPTION },
      { type: 'Person', name: w.label, description: `A resident who witnessed the courtyard planting.` }
    ],
    relationships: [
      {
        source: { type: 'Person', name: w.label },
        predicate: 'witnessed',
        target: EVENT_ENTITY,
        description: `${w.label} was present at the planting.`,
        weight: 0.9
      }
    ],
    claims: [SHARED_OBJECTIVE_CLAIM, w.subjective]
  }
}

export const WITNESSES: Witness[] = [
  {
    id: 'ada',
    label: 'Ada',
    did: 'did:key:z-demo-ada',
    account:
      'I still think of the drought when I walk past that corner. On Saturday morning the three of us finally planted the fig tree in the courtyard. We dug a pit and backfilled it with compost. For me it was repair — mending what the dry years took. I did it reverently, the way you tend something you love. Honestly it had been a long time coming.'
  },
  {
    id: 'bo',
    label: 'Bo',
    did: 'did:key:z-demo-bo',
    account:
      'Saturday morning, the three of us planted a fig tree in the courtyard. We dug a pit and backfilled with compost. To me it is a gift to the future — I keep picturing children climbing it one day. The kids were already helping, so we did the whole thing cheerfully. It felt like the start of something.'
  },
  {
    id: 'cy',
    label: 'Cy',
    did: 'did:key:z-demo-cy',
    account:
      'On Saturday morning three of us planted a fig tree in the courtyard — dug a pit, backfilled with compost. I was keeping a promise I had made to a neighbour who is gone now. I did it quietly, alone at first, before the others arrived. It was overdue, and it mattered to get it done.'
  }
]

// Per-witness subjective claims. Distinct statements → distinct claim
// URIs → they never merge; each keeps a single asserter.
const SUBJECTIVE_BY_ID: Record<string, ExtractedClaim> = {
  ada: {
    about: EVENT_ENTITY,
    statement: 'For Ada, the planting was an act of repair.',
    cells: [
      { cell: 'why·subjective', filler: 'to repair what the drought took' },
      { cell: 'how·subjective', filler: 'reverently, like tending something loved' },
      { cell: 'when·subjective', filler: 'a long time coming' }
    ]
  },
  bo: {
    about: EVENT_ENTITY,
    statement: 'For Bo, the planting was a gift to the future.',
    cells: [
      { cell: 'why·subjective', filler: 'so children would climb it one day' },
      { cell: 'how·subjective', filler: 'cheerfully, with the kids helping' },
      { cell: 'when·subjective', filler: 'the start of something' }
    ]
  },
  cy: {
    about: EVENT_ENTITY,
    statement: 'For Cy, the planting kept a promise.',
    cells: [
      { cell: 'why·subjective', filler: 'to honour a promise to a neighbour' },
      { cell: 'how·subjective', filler: 'quietly, alone at first' },
      { cell: 'when·subjective', filler: 'overdue' }
    ]
  }
}

const EXTRACTION_BY_TEXT = new Map<string, ExtractionResult>()
for (const w of WITNESSES) {
  EXTRACTION_BY_TEXT.set(
    normalise(w.account),
    witnessExtraction({ label: w.label, subjective: SUBJECTIVE_BY_ID[w.id] })
  )
}

/** The library's Extractor seam, backed by curated results keyed on passage text. */
export function createScriptedExtractor() {
  return {
    async extract(passage: string): Promise<ExtractionResult> {
      const hit = EXTRACTION_BY_TEXT.get(normalise(passage))
      return hit ?? { entities: [], relationships: [], claims: [] }
    }
  }
}

/** Metadata the backend needs to reconstruct the shared claim's URI for the publish round-trip. */
export const SHARED_CLAIM_REF = {
  aboutType: EVENT_ENTITY.type,
  aboutName: EVENT_ENTITY.name,
  statement: SHARED_OBJECTIVE_CLAIM.statement
}

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
