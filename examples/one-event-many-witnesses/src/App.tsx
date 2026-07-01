import { createMemo, createSignal, For, onMount, Show } from 'solid-js'
import {
  api,
  type Ad4mStatus,
  type EventResponse,
  type GridCell,
  type GridResponse,
  type PublishResult,
  type QueryResult,
  type Status,
  type Witness
} from './api.ts'

interface Palette {
  dot: string
  chip: string
  ring: string
}

const PALETTE: Palette[] = [
  { dot: 'bg-sky-400', chip: 'bg-sky-400/15 text-sky-200 border-sky-400/30', ring: 'ring-sky-400/50' },
  { dot: 'bg-fuchsia-400', chip: 'bg-fuchsia-400/15 text-fuchsia-200 border-fuchsia-400/30', ring: 'ring-fuchsia-400/50' },
  { dot: 'bg-lime-400', chip: 'bg-lime-400/15 text-lime-200 border-lime-400/30', ring: 'ring-lime-400/50' }
]

export default function App() {
  const [status, setStatus] = createSignal<Status | null>(null)
  const [event, setEvent] = createSignal<EventResponse | null>(null)
  const [grid, setGrid] = createSignal<GridResponse | null>(null)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [focused, setFocused] = createSignal<GridCell | null>(null)
  const [queryTitle, setQueryTitle] = createSignal<string>('')
  const [queryResult, setQueryResult] = createSignal<QueryResult | null>(null)
  const [queryBusy, setQueryBusy] = createSignal(false)
  const [question, setQuestion] = createSignal('')
  const [ad4m, setAd4m] = createSignal<Ad4mStatus | null>(null)
  const [publish, setPublish] = createSignal<PublishResult | null>(null)
  const [publishBusy, setPublishBusy] = createSignal(false)

  const paletteFor = (id: string): Palette => {
    const ws = event()?.witnesses ?? []
    const idx = ws.findIndex((w) => w.id === id)
    return PALETTE[idx % PALETTE.length] ?? PALETTE[0]
  }

  const selectedArray = () => [...selected()]

  onMount(() => void poll())

  async function poll() {
    try {
      const s = await api.status()
      setStatus(s)
      if (s.ready) {
        await init()
        return
      }
      if (s.error) return
    } catch {
      /* backend still starting; keep polling */
    }
    setTimeout(() => void poll(), 1500)
  }

  async function init() {
    const ev = await api.event()
    setEvent(ev)
    setSelected(new Set(ev.witnesses.map((w) => w.id)))
    await Promise.all([loadGrid(), loadAd4m()])
  }

  const didFor = (id: string) => event()?.witnesses.find((w) => w.id === id)?.did

  function selectedDids(): string[] {
    const ids = selectedArray()
    return ids.map(didFor).filter((d): d is string => !!d)
  }

  async function loadGrid() {
    setGrid(await api.grid(selectedDids()))
  }

  async function loadAd4m() {
    setAd4m(await api.ad4m())
  }

  function toggleWitness(id: string) {
    const next = new Set(selected())
    if (next.has(id)) {
      if (next.size === 1) return // keep at least one lens on
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelected(next)
    void refresh()
  }

  async function refresh() {
    await loadGrid()
    const fc = focused()
    if (fc) await runCellQuery(fc)
  }

  async function runCellQuery(cell: GridCell) {
    if (cell.empty) {
      setFocused(cell)
      setQueryTitle(`${cellName(cell)} — blind spot`)
      setQueryResult(null)
      return
    }
    setFocused(cell)
    setQueryTitle(`${cellName(cell)}`)
    setQueryBusy(true)
    try {
      const lens = cell.axis === 'objective' ? 'Objectively' : 'Subjectively'
      const q = `${lens}, what do the witnesses report about "${cell.interrogative}" for this event?`
      const r = await api.query({ question: q, byCell: [{ cell: cell.cell }], dids: selectedDids() })
      setQueryResult(r)
    } finally {
      setQueryBusy(false)
    }
  }

  async function runFreeQuery(q: string) {
    const text = q.trim()
    if (!text) return
    setFocused(null)
    setQueryTitle(`“${text}”`)
    setQueryBusy(true)
    try {
      setQueryResult(await api.query({ question: text, dids: selectedDids() }))
    } finally {
      setQueryBusy(false)
    }
  }

  async function doPublish() {
    setPublishBusy(true)
    try {
      const r = await api.publish(grid()?.sharedClaimUri)
      setPublish(r)
      await loadAd4m()
    } finally {
      setPublishBusy(false)
    }
  }

  const rows = createMemo(() => {
    const g = grid()
    if (!g) return []
    const map = new Map<string, { interrogative: string; objective?: GridCell; subjective?: GridCell }>()
    for (const c of g.cells) {
      const r = map.get(c.interrogative) ?? { interrogative: c.interrogative }
      if (c.axis === 'objective') r.objective = c
      else r.subjective = c
      map.set(c.interrogative, r)
    }
    return [...map.values()]
  })

  return (
    <Show when={status()?.ready} fallback={<Boot status={status()} />}>
      <div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <Header event={event()} status={status()} />

        <Section title="The witnesses" hint="Each contributes one first-person account. Toggle a lens off to re-scope every panel below by provenance.">
          <div class="grid gap-3 sm:grid-cols-3">
            <For each={event()?.witnesses ?? []}>
              {(w) => (
                <WitnessCard
                  w={w}
                  palette={paletteFor(w.id)}
                  on={selected().has(w.id)}
                  onToggle={() => toggleWitness(w.id)}
                />
              )}
            </For>
          </div>
        </Section>

        <Section
          title="Twelve cells"
          hint="Six interrogatives × two lenses. Tap any populated cell to retrieve on it. Watch the objective column converge and the subjective column stay plural."
        >
          <Legend />
          <div class="mt-3 grid grid-cols-[3.2rem_1fr_1fr] gap-1.5 sm:grid-cols-[5.5rem_1fr_1fr] sm:gap-2">
            <div />
            <ColHead label="Objective" sub="observed / agreed" tone="text-sky-300" />
            <ColHead label="Subjective" sub="felt / intended" tone="text-amber-300" />
            <For each={rows()}>
              {(row) => (
                <>
                  <div class="flex items-center justify-end pr-1 text-xs font-semibold uppercase tracking-wide text-neutral-400 sm:text-sm">
                    {row.interrogative}
                  </div>
                  <CellCard cell={row.objective} focused={focused()} onTap={runCellQuery} paletteFor={paletteFor} />
                  <CellCard cell={row.subjective} focused={focused()} onTap={runCellQuery} paletteFor={paletteFor} />
                </>
              )}
            </For>
          </div>
        </Section>

        <div class="grid gap-4 lg:grid-cols-2">
          <Section title="Retrieval" hint="Cell-aware queries seed from the claims carrying that cell; free questions fall back to vector search.">
            <QuestionBar question={question()} setQuestion={setQuestion} onAsk={runFreeQuery} busy={queryBusy()} />
            <QueryPanel title={queryTitle()} result={queryResult()} busy={queryBusy()} focused={focused()} />
          </Section>

          <div class="flex flex-col gap-4">
            <Section title="Blind-spot audit" hint="An empty cell is a precise statement of unobserved information — not a gap to paper over.">
              <BlindSpots grid={grid()} />
            </Section>
            <Section title="AD4M commons" hint="Publish the converged claim into the shared perspective, then read it straight back out of AD4M — proof the 12-cell decomposition and every witness DID survive the round-trip.">
              <Commons
                ad4m={ad4m()}
                publish={publish()}
                busy={publishBusy()}
                onPublish={doPublish}
                paletteFor={paletteFor}
                witnessLabel={(did) => event()?.witnesses.find((w) => w.did === did)?.label}
              />
            </Section>
          </div>
        </div>

        <footer class="mt-10 border-t border-neutral-800 pt-4 text-xs text-neutral-500">
          Deterministic offline demo of{' '}
          <span class="font-mono text-neutral-400">@hexafield/ad4m-rag</span> — feature-hash embedder, scripted
          extractor, isolated single-node AD4M executor. No network, no API keys.
        </footer>
      </div>
    </Show>
  )
}

function cellName(c: GridCell): string {
  return `${c.interrogative}·${c.axis}`
}

// ── Boot ────────────────────────────────────────────────────────────

function Boot(props: { status: Status | null }) {
  const s = () => props.status
  return (
    <div class="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      <div class="hex-pulse text-5xl text-sky-400">⬡</div>
      <div class="text-lg font-medium text-neutral-200">Booting an isolated AD4M node</div>
      <div class="max-w-sm text-sm text-neutral-400">
        <Show when={!s()?.error} fallback={<span class="text-rose-400">Boot failed: {s()?.error}</span>}>
          {s()?.phase ?? 'starting'}
          <span class="hex-pulse">…</span>
        </Show>
      </div>
      <div class="max-w-sm text-xs text-neutral-600">
        Holochain bring-up takes a moment on first start. This node runs on its own temp data dir and random
        localhost ports — nothing else on the machine is touched.
      </div>
    </div>
  )
}

// ── Header ──────────────────────────────────────────────────────────

function Header(props: { event: EventResponse | null; status: Status | null }) {
  return (
    <header class="mb-8">
      <div class="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-300">
          ⬡ isolated node · port {props.status?.executorPort ?? '—'}
        </span>
        <Show when={props.status?.agentDid}>
          <span class="rounded-full border border-neutral-700 bg-neutral-900 px-2 py-0.5 font-mono text-neutral-400">
            {shortDid(props.status!.agentDid!)}
          </span>
        </Show>
      </div>
      <h1 class="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">
        {props.event?.event.title ?? 'One event, many witnesses'}
      </h1>
      <p class="mt-2 text-lg text-neutral-300">{props.event?.event.headline}</p>
      <p class="mt-2 max-w-3xl text-sm leading-relaxed text-neutral-400">{props.event?.event.blurb}</p>
    </header>
  )
}

// ── Layout helpers ──────────────────────────────────────────────────

function Section(props: { title: string; hint?: string; children: any }) {
  return (
    <section class="mb-6 rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4 sm:p-5">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-300">{props.title}</h2>
      <Show when={props.hint}>
        <p class="mt-1 text-xs leading-relaxed text-neutral-500">{props.hint}</p>
      </Show>
      <div class="mt-4">{props.children}</div>
    </section>
  )
}

function ColHead(props: { label: string; sub: string; tone: string }) {
  return (
    <div class="pb-1">
      <div class={`text-xs font-semibold uppercase tracking-wide sm:text-sm ${props.tone}`}>{props.label}</div>
      <div class="text-[10px] text-neutral-500 sm:text-xs">{props.sub}</div>
    </div>
  )
}

function Legend() {
  return (
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400">
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-2.5 rounded-sm border border-emerald-500/50 bg-emerald-500/15" /> converged
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-2.5 rounded-sm border border-amber-500/50 bg-amber-500/15" /> diverged
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-neutral-600" /> blind spot
      </span>
    </div>
  )
}

// ── Witness card ────────────────────────────────────────────────────

function WitnessCard(props: { w: Witness; palette: Palette; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      class={`group flex flex-col rounded-xl border p-3 text-left transition ${
        props.on
          ? 'border-neutral-700 bg-neutral-900 ring-1 ' + props.palette.ring
          : 'border-neutral-800 bg-neutral-950/60 opacity-50'
      }`}
    >
      <div class="flex items-center gap-2">
        <span class={`inline-block h-2.5 w-2.5 rounded-full ${props.palette.dot}`} />
        <span class="font-medium text-neutral-100">{props.w.label}</span>
        <span class={`ml-auto text-[10px] uppercase tracking-wide ${props.on ? 'text-emerald-400' : 'text-neutral-600'}`}>
          {props.on ? 'on' : 'off'}
        </span>
      </div>
      <p class="mt-2 line-clamp-4 text-xs leading-relaxed text-neutral-400 group-hover:text-neutral-300">
        {props.w.account}
      </p>
    </button>
  )
}

// ── Grid cell ───────────────────────────────────────────────────────

function CellCard(props: {
  cell?: GridCell
  focused: GridCell | null
  onTap: (c: GridCell) => void
  paletteFor: (id: string) => Palette
}) {
  const c = () => props.cell
  const isFocused = () => !!c() && props.focused?.cell === c()!.cell
  const tone = () => {
    const cell = c()
    if (!cell || cell.empty) return 'border-dashed border-neutral-700 bg-neutral-900/30'
    if (cell.converged) return 'border-emerald-500/40 bg-emerald-500/[0.06] hover:bg-emerald-500/10'
    if (cell.diverged) return 'border-amber-500/40 bg-amber-500/[0.06] hover:bg-amber-500/10'
    return 'border-neutral-700 bg-neutral-900 hover:bg-neutral-800/70'
  }
  return (
    <Show when={c()} fallback={<div />}>
      <button
        type="button"
        disabled={c()!.empty}
        onClick={() => props.onTap(c()!)}
        title={c()!.label}
        class={`flex min-h-[3.5rem] flex-col rounded-lg border p-2 text-left transition sm:min-h-[4.5rem] ${tone()} ${
          isFocused() ? 'ring-2 ring-neutral-100/70' : ''
        } ${c()!.empty ? 'cursor-default' : 'cursor-pointer'}`}
      >
        <Show
          when={!c()!.empty}
          fallback={<span class="m-auto text-[11px] italic text-neutral-600">not recorded</span>}
        >
          <div class="flex flex-col gap-1.5">
            <For each={c()!.fillers}>
              {(f) => (
                <div class="flex items-start gap-1.5">
                  <div class="mt-0.5 flex shrink-0 gap-0.5">
                    <For each={f.witnesses}>
                      {(wr) => (
                        <span
                          title={wr.label}
                          class={`inline-block h-2 w-2 rounded-full ${props.paletteFor(wr.id).dot}`}
                        />
                      )}
                    </For>
                  </div>
                  <span class="text-[11px] leading-snug text-neutral-200 sm:text-xs">{f.filler}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </button>
    </Show>
  )
}

// ── Question bar + query panel ──────────────────────────────────────

function QuestionBar(props: {
  question: string
  setQuestion: (v: string) => void
  onAsk: (q: string) => void
  busy: boolean
}) {
  const suggestions = ['Why was the fig tree planted?', 'What happened in the courtyard?', 'When did it happen?']
  return (
    <div>
      <form
        class="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          props.onAsk(props.question)
        }}
      >
        <input
          value={props.question}
          onInput={(e) => props.setQuestion(e.currentTarget.value)}
          placeholder="Ask the graph…"
          class="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-sky-500/60"
        />
        <button
          type="submit"
          disabled={props.busy || !props.question.trim()}
          class="rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-500/25 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <For each={suggestions}>
          {(s) => (
            <button
              type="button"
              onClick={() => {
                props.setQuestion(s)
                props.onAsk(s)
              }}
              class="rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-[11px] text-neutral-400 transition hover:border-neutral-600 hover:text-neutral-200"
            >
              {s}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

function QueryPanel(props: { title: string; result: QueryResult | null; busy: boolean; focused: GridCell | null }) {
  return (
    <div class="mt-4 rounded-xl border border-neutral-800 bg-neutral-950/60 p-3">
      <Show
        when={props.title}
        fallback={<p class="text-sm text-neutral-500">Tap a cell above, or ask a question.</p>}
      >
        <div class="mb-2 font-mono text-xs text-neutral-400">{props.title}</div>
        <Show
          when={!props.busy}
          fallback={
            <p class="text-sm text-neutral-500">
              retrieving<span class="hex-pulse">…</span>
            </p>
          }
        >
          <Show
            when={props.result}
            fallback={
              <p class="text-sm italic text-neutral-500">
                Nobody recorded this cell. There is no objective “why” for this event — the motive lives entirely in
                the subjective column.
              </p>
            }
          >
            <p class="whitespace-pre-wrap text-sm leading-relaxed text-neutral-100">{props.result!.answer}</p>
            <div class="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
              <span>mode: {props.result!.mode}</span>
              <span>seeds: {props.result!.trace.retrievalK ?? 0}</span>
              <span>llm calls: {props.result!.trace.llmCalls ?? 0}</span>
              <span>{props.result!.trace.durationMs ?? 0} ms</span>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

// ── Blind spots ─────────────────────────────────────────────────────

function BlindSpots(props: { grid: GridResponse | null }) {
  const spots = () => props.grid?.blindSpots ?? []
  return (
    <Show
      when={spots().length > 0}
      fallback={<p class="text-sm text-neutral-500">Every cell has at least one witness under the current lens.</p>}
    >
      <ul class="flex flex-col gap-2">
        <For each={spots()}>
          {(s) => (
            <li class="flex items-center gap-2 rounded-lg border border-dashed border-neutral-700 bg-neutral-950/40 px-3 py-2">
              <span class="font-mono text-xs text-neutral-300">{s}</span>
              <span class="text-xs text-neutral-500">— no witness recorded this</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

// ── Commons / AD4M round-trip ───────────────────────────────────────

function Commons(props: {
  ad4m: Ad4mStatus | null
  publish: PublishResult | null
  busy: boolean
  onPublish: () => void
  paletteFor: (id: string) => Palette
  witnessLabel: (did: string) => string | undefined
}) {
  const cellsByCell = createMemo(() => {
    const claim = props.publish?.claim
    if (!claim) return []
    const map = new Map<string, string[]>()
    for (const c of claim.cells) {
      const arr = map.get(c.cell) ?? []
      arr.push(c.filler)
      map.set(c.cell, arr)
    }
    return [...map.entries()].map(([cell, fillers]) => ({ cell, fillers }))
  })

  return (
    <div>
      <div class="flex items-center gap-3">
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onPublish}
          class="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-40"
        >
          {props.busy ? 'publishing…' : 'Publish converged claim → commons'}
        </button>
        <div class="text-xs text-neutral-500">
          commons links: <span class="font-mono text-neutral-300">{props.ad4m?.commonsLinkCount ?? 0}</span>
        </div>
      </div>

      <Show when={props.publish?.claim}>
        {(claim) => (
          <div class="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
            <div class="text-[11px] uppercase tracking-wide text-emerald-300/80">read back out of AD4M</div>
            <p class="mt-1 text-sm text-neutral-100">{claim().statement}</p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <For each={claim().assertedBy}>
                {(a) => (
                  <span class={`rounded-full border px-2 py-0.5 text-[11px] ${props.paletteFor(labelToId(props.witnessLabel(a.did))).chip}`}>
                    {props.witnessLabel(a.did) ?? shortDid(a.did)}
                  </span>
                )}
              </For>
            </div>
            <div class="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
              <For each={cellsByCell()}>
                {(row) => (
                  <div class="flex gap-2 rounded-md bg-neutral-950/50 px-2 py-1">
                    <span class="shrink-0 font-mono text-[11px] text-neutral-400">{row.cell}</span>
                    <span class="text-[11px] text-neutral-200">{row.fillers.join(' / ')}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

// ── misc ────────────────────────────────────────────────────────────

function shortDid(did: string): string {
  if (did.length <= 16) return did
  return `${did.slice(0, 10)}…${did.slice(-4)}`
}

// The palette lookup is keyed by witness id; for the AD4M read-back we
// only have a label, so map label → id via the known demo ids.
function labelToId(label: string | undefined): string {
  return (label ?? '').toLowerCase()
}
