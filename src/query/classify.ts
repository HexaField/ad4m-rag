// Auto-mode classifier. Rule-based and deterministic. Broad / structural
// cues → 'global'; otherwise → 'local'. Override always wins.

const GLOBAL_CUES = [
  // English structural cues
  /\bwhat\s+are\b/i,
  /\bwhich\s+are\b/i,
  /\bhow\s+many\b/i,
  /\boverall\b/i,
  /\boverview\b/i,
  /\bsummari[sz]e\b/i,
  /\bthemes?\b/i,
  /\btopics?\b/i,
  /\bacross\b/i,
  /\bcommon\b/i,
  /\bgeneral(?:ly)?\b/i,
  /\bcompare\b/i,
  /\bcontrast\b/i,
  /\bpatterns?\b/i,
  /\bstructure\b/i,
  /\bbroadly\b/i
]

const LOCAL_CUES = [
  /\bwho\s+is\b/i,
  /\bwhere\s+is\b/i,
  /\bwhen\s+(?:did|does|was|were)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bwhat\s+did\b/i,
  /\bdetails?\s+(?:of|about)\b/i
]

export function classifyQueryMode(question: string): 'local' | 'global' {
  let globalScore = 0
  let localScore = 0
  for (const re of GLOBAL_CUES) if (re.test(question)) globalScore++
  for (const re of LOCAL_CUES) if (re.test(question)) localScore++
  if (globalScore > localScore) return 'global'
  return 'local'
}
