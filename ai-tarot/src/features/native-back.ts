type BackEventHandlers = {
  onEvent: () => void
  onError: (error: Error) => void
}

const APP_HISTORY_PREDECESSOR_KEY = '__tarororoHasAppHistoryPredecessor'

type SubscribeNativeBackOptions = {
  active: boolean
  hasPreviousEntry: boolean
  subscribe: (event: 'backEvent', handlers: BackEventHandlers) => () => void
  goBack: () => void
  goToRoot: () => void
  onError: (error: Error) => void
}

export function hasAppHistoryPredecessor(state: unknown): boolean {
  return typeof state === 'object'
    && state !== null
    && (state as Record<string, unknown>)[APP_HISTORY_PREDECESSOR_KEY] === true
}

export function withAppHistoryPredecessor(
  state: unknown,
  hasPreviousEntry: boolean,
): Record<string, unknown> {
  const current = typeof state === 'object' && state !== null && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
  return { ...current, [APP_HISTORY_PREDECESSOR_KEY]: hasPreviousEntry }
}

export function subscribeNativeBack(options: SubscribeNativeBackOptions): (() => void) | undefined {
  if (!options.active) return undefined
  return options.subscribe('backEvent', {
    onEvent: options.hasPreviousEntry ? options.goBack : options.goToRoot,
    onError: options.onError,
  })
}
