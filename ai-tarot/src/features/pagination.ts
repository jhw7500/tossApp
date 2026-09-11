export type Page<T> = {
  items: T[]
  nextCursor: string | null
}

export function buildPagePath(path: string, cursor?: string | null): string {
  const query = new URLSearchParams({ limit: '100' })
  if (cursor) query.set('cursor', cursor)
  return `${path}?${query.toString()}`
}

export function mergePage<T extends { id: string }>(current: Page<T>, incoming: Page<T>): Page<T> {
  const existingIds = new Set(current.items.map(item => item.id))
  const items = [...current.items]
  for (const item of incoming.items) {
    if (existingIds.has(item.id)) continue
    existingIds.add(item.id)
    items.push(item)
  }
  return {
    items,
    nextCursor: incoming.nextCursor,
  }
}

export function updateCurrentScope<State extends { scope: string }>(state: State, requestScope: string, update: (current: State) => State): State {
  return state.scope === requestScope ? update(state) : state
}
