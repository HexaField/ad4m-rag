// Thin façade over the host-provided Ad4mClient. The library is given an
// already-authenticated client + perspective handles; we never construct
// or own connections.
//
// AD4M's Ad4mClient surface is large — this façade exposes only the
// methods the store / publication / subscription paths need.

import type { Ad4mClient, Link, PerspectiveProxy } from '@coasys/ad4m'

export interface Ad4mClientFacade {
  /** Resolve the private/local perspective by uuid. */
  perspectiveByUuid(uuid: string): Promise<PerspectiveProxy | null>
  /** Add a batch of links to a perspective. */
  addLinks(perspectiveUuid: string, links: Link[]): Promise<void>
  /** Remove a single link by (source, predicate, target). */
  removeLink(perspectiveUuid: string, link: { source: string; predicate: string; target: string }): Promise<void>
  /** Query all links for a perspective (used during initial sync and reindex). */
  queryAllLinks(perspectiveUuid: string): Promise<{ data: { source: string; predicate: string; target: string } }[]>
  /** Subscribe to link.added / link.removed events for a perspective. */
  subscribeLinks(
    perspectiveUuid: string,
    onAdded: (link: { data: { source: string; predicate: string; target: string } }) => void,
    onRemoved: (link: { data: { source: string; predicate: string; target: string } }) => void
  ): () => void
}

export function createAd4mFacade(client: Ad4mClient): Ad4mClientFacade {
  return {
    async perspectiveByUuid(uuid) {
      const p = await client.perspective.byUUID(uuid)
      return p ?? null
    },
    async addLinks(perspectiveUuid, links) {
      if (links.length === 0) return
      // The SDK accepts an array directly.
      await client.perspective.addLinks(perspectiveUuid, links)
    },
    async removeLink(perspectiveUuid, link) {
      // PerspectiveClient.removeLink expects a LinkExpression — synthesise the minimum shape.
      const synthetic = {
        author: '',
        timestamp: '',
        data: { source: link.source, predicate: link.predicate, target: link.target },
        proof: { signature: '', key: '', valid: true }
      } as unknown as Parameters<typeof client.perspective.removeLink>[1]
      await client.perspective.removeLink(perspectiveUuid, synthetic)
    },
    async queryAllLinks(perspectiveUuid) {
      const results = await client.perspective.queryLinks(perspectiveUuid, { source: '', predicate: '', target: '' } as never)
      // LinkExpression has data, author, timestamp, proof — keep only `data`.
      return (results ?? []).map((r: any) => ({ data: r.data })) as {
        data: { source: string; predicate: string; target: string }
      }[]
    },
    subscribeLinks(perspectiveUuid, onAdded, onRemoved) {
      const addedHandler = (link: unknown) => {
        onAdded(link as { data: { source: string; predicate: string; target: string } })
      }
      const removedHandler = (link: unknown) => {
        onRemoved(link as { data: { source: string; predicate: string; target: string } })
      }
      client.perspective.addPerspectiveLinkAddedListener(perspectiveUuid, [addedHandler as never])
      client.perspective.addPerspectiveLinkRemovedListener(perspectiveUuid, [removedHandler as never])
      return () => {
        // The current SDK doesn't expose remove listeners by reference. The host
        // is responsible for tearing down its Ad4mClient at process end.
      }
    }
  }
}
