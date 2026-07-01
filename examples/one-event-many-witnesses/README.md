# One event, many witnesses

A live, self-contained demo of [`@hexafield/ad4m-rag`](../../). Three people
witness the same small event — *a fig tree planted in a shared courtyard* — and
each gives a first-person account. The demo runs the library's real ingest and
query pipeline over those three accounts and shows what the 12-cell
[hexevent](https://github.com/HexaField/hexevent) decomposition buys you:

- **The objective row converges.** Every witness reports the same *who / what /
  when / where / how* facts, so the library's content-hash identity merge
  collapses the three copies into **one claim** whose `assertedBy` set
  accumulates all three DIDs.
- **The subjective row stays plural.** Their *felt* timing, *why*, and *manner*
  differ, so those cells remain three distinct single-witness claims —
  disagreement preserved, not averaged away.
- **Empty cells are information.** Nobody recorded a `why·objective`. That cell
  stays blank on purpose: a precise statement of what was *not* observed, not a
  gap to paper over.

Everything is driven from that one dataset — retrieval, provenance filtering,
the blind-spot audit, and a real round-trip through AD4M.

## What each panel shows

| Panel | What it demonstrates |
|---|---|
| **The witnesses** | Per-claim provenance. Each account is asserted by a distinct DID. Toggle a witness off to re-scope every panel below by provenance (`fromAgents`). |
| **Twelve cells** | The 5W1H × objective/subjective grid. Cells are coloured **converged** (one shared filler, multiple witnesses), **diverged** (multiple fillers), or **blind spot** (empty). Tap any populated cell to retrieve on it. |
| **Retrieval** | Two query paths. A tapped cell runs **cell-aware retrieval** (`byCell` seeds from the claims carrying that cell); a free-text question falls back to vector search. Answers are synthesised from the retrieved claims. |
| **Blind-spot audit** | The four empty cells, stated explicitly — the informative negative space. |
| **AD4M commons** | Publishes the converged claim into a shared perspective, then reads it **straight back out of AD4M** and re-parses it — proof the 12-cell decomposition and every witness DID survive the round-trip. Idempotent: re-publishing does not duplicate links. |

## Running it

```bash
# from this directory
npm install
npm run dev
```

`npm run dev` builds the library (`predev`), then starts Vite. Open the printed
URL. The Vite dev server binds `0.0.0.0` (`server.host: true`), so the
`Network:` URLs are reachable from other devices on your LAN — the layout is
responsive for both desktop and mobile.

First load shows a boot progress line while the isolated AD4M node comes up
(Holochain bring-up takes a little while); the UI polls `GET /api/status` and
reveals the demo when it flips to `ready`.

### Prerequisites

- **Node** with native TypeScript execution (the backend runs as
  `node server/index.ts`, no loader flag).
- **`ad4m-executor` on `PATH`** — the demo spawns a real executor. Point at a
  specific binary with `AD4M_EXECUTOR=/path/to/ad4m-executor` if it isn't on
  `PATH`. Increase the 120 s startup budget with `AD4M_DEMO_TIMEOUT=<seconds>`.

No network access and no API keys are needed: the embedder and LLM are
deterministic offline stand-ins (see *How it's wired* below).

## Isolation guarantee

The demo **never touches any other AD4M executor or data on the machine.** On
boot it spins up a throwaway node with:

- its own temp data dir (`$TMPDIR/ad4m-rag-demo-*`), created fresh per run;
- three **random** localhost ports (RPC + Holochain admin/app);
- `--localhost true` and peer discovery disabled (`--hc-use-bootstrap false`,
  `--hc-use-mdns false`, `--hc-use-proxy false`);
- a random admin credential and agent passphrase.

On shutdown (Ctrl-C, or when the dev server stops) the executor is asked to quit,
then killed, and its temp data dir is removed.

## How it's wired

```
vite (LAN surface, :4321) ──proxy /api──► node server/index.ts (127.0.0.1, isolated)
        │                                          │
   src/ (SolidJS UI)                         server/graph.ts  ── composes ──►  @hexafield/ad4m-rag
                                                   │                              (real ingest + query + store)
                                             server/executor.ts ── spawns ──►  isolated ad4m-executor
```

- **Frontend** — `src/` — SolidJS + Tailwind v4, built by Vite. Talks only to
  `/api`.
- **Vite plugin** — `vite-plugin-ad4m.ts` — reserves a free port, spawns the
  backend bound to it, proxies `/api` there, and kills the child on shutdown.
- **Backend** — `server/index.ts` — a tiny `node:http` JSON API. Binds
  `127.0.0.1` only; Vite is the LAN-facing surface.
- **Graph composition** — `server/graph.ts` — wires the library's real building
  blocks (sqlite index, ingest pipeline, query engine, AD4M-backed store) by
  hand. It mirrors `createAd4mRag` from the library but keeps the raw
  `SqliteIndex` handle so it can read cell assignments for the grid.
- **Deterministic clients** — `server/clients.ts` — a feature-hashing embedder
  and a scripted LLM. Real implementations of the library's `EmbeddingClient` /
  `LlmClient` seams (in production you'd wire Ollama + Anthropic), chosen so the
  demo is fully deterministic and offline.
- **Corpus** — `server/corpus.ts` — the one event, three witnesses, and their
  curated extractions. Extraction is scripted (not LLM-driven) so the objective
  cells match exactly across witnesses and the identity merge is guaranteed.

## API surface

The backend exposes a small read-oriented API (all under `/api`):

| Route | Purpose |
|---|---|
| `GET /api/status` | Boot phase + `ready` flag; agent DID and perspective UUIDs once up. |
| `GET /api/event` | The event and the three raw witness accounts. |
| `GET /api/grid?dids=<csv>` | The 12-cell grid, optionally scoped to a subset of witnesses. |
| `GET /api/claim?uri=<uri>` | A single claim as stored locally. |
| `GET /api/ad4m` | Live link counts for the private + commons perspectives. |
| `POST /api/query` | `{ question, byCell?, dids? }` → synthesised answer + citations. |
| `POST /api/publish` | Publish the converged claim to the commons and read it back. |

## Stack

TypeScript · SolidJS · Tailwind CSS v4 (`@tailwindcss/vite`) · Vite 6
(`vite-plugin-solid`).
