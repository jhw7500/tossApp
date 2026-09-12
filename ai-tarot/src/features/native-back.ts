type BackEventHandlers = {
  onEvent: () => void
  onError: (error: Error) => void
}

type SubscribeNativeBackOptions = {
  active: boolean
  subscribe: (event: 'backEvent', handlers: BackEventHandlers) => () => void
  goBack: () => void
  onError: (error: Error) => void
}

export function subscribeNativeBack(options: SubscribeNativeBackOptions): (() => void) | undefined {
  if (!options.active) return undefined
  return options.subscribe('backEvent', {
    onEvent: options.goBack,
    onError: options.onError,
  })
}
