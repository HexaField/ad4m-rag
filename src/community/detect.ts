// Multi-level Leiden community detection over the entity-relationship
// graph. Returns a hierarchical partition: level 0 is the finest
// partition, each subsequent level groups level-N communities together
// at lower resolution.
//
// leiden-ts produces a single partition per run; we materialise multiple
// levels by re-running on the contracted super-graph at decreasing
// resolutions.

import { Graph, leiden } from 'leiden-ts'
import type { Relationship } from '../types.js'

export interface DetectOptions {
  /** Number of hierarchy levels. Default 3 — leaves + two coarser groupings. */
  levels?: number
  /** Base resolution for level 0. Higher = smaller, denser leaf communities. */
  baseResolution?: number
  /** Multiplier applied per level — resolutions[i] = baseResolution * resolutionDecay^i. */
  resolutionDecay?: number
  /** Random seed for reproducibility. */
  seed?: number
}

export interface DetectedLevel {
  /** Hierarchy level: 0 = leaves, higher = broader groupings. */
  level: number
  /** Map of entity URI → community id at this level. */
  assignments: Map<string, number>
  /** Map of community id → list of member entity URIs. */
  members: Map<number, string[]>
}

/** Detect communities at multiple resolutions over the entity-relationship graph. */
export function detectHierarchy(
  entityUris: string[],
  relationships: Relationship[],
  opts: DetectOptions = {}
): DetectedLevel[] {
  const levels = opts.levels ?? 3
  const baseRes = opts.baseResolution ?? 1.0
  const decay = opts.resolutionDecay ?? 0.5
  const seed = opts.seed ?? 1

  if (entityUris.length === 0) return []

  // Build the node-index map.
  const uriToIndex = new Map<string, number>()
  for (let i = 0; i < entityUris.length; i++) uriToIndex.set(entityUris[i], i)

  // Build the deduplicated weighted edge list. Multiple relationships
  // between the same pair are coalesced by summing their weights.
  const edgeKey = (u: number, v: number) => (u < v ? `${u}|${v}` : `${v}|${u}`)
  const edges = new Map<string, { u: number; v: number; weight: number }>()
  for (const r of relationships) {
    const u = uriToIndex.get(r.source)
    const v = uriToIndex.get(r.target)
    if (u === undefined || v === undefined) continue
    if (u === v) continue
    const key = edgeKey(u, v)
    const existing = edges.get(key)
    if (existing) {
      existing.weight += r.weight
    } else {
      edges.set(key, { u, v, weight: r.weight })
    }
  }
  const edgeList = [...edges.values()].map((e): readonly [number, number, number] => [e.u, e.v, e.weight] as const)

  const graph = Graph.fromEdgeList(entityUris.length, edgeList, { selfLoops: 'collapse' })

  const out: DetectedLevel[] = []
  for (let lvl = 0; lvl < levels; lvl++) {
    const resolution = baseRes * Math.pow(decay, lvl)
    const result = leiden(graph, { resolution, seed: seed + lvl })
    const assignments = new Map<string, number>()
    const members = new Map<number, string[]>()
    for (let i = 0; i < entityUris.length; i++) {
      const c = result.partition.assignments[i]
      assignments.set(entityUris[i], c)
      const arr = members.get(c) ?? []
      arr.push(entityUris[i])
      members.set(c, arr)
    }
    out.push({ level: lvl, assignments, members })
  }
  return out
}
