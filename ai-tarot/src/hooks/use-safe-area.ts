import { SafeArea } from '@apps-in-toss/web-framework'
import { useEffect } from 'react'

export const SAFE_AREA_CHANGE_EVENT = 'tarororo:safe-area-change'

const setInsets = (insets: { top: number; right: number; bottom: number; left: number }) => {
  const root = document.documentElement.style
  root.setProperty('--safe-area-top', `${insets.top}px`)
  root.setProperty('--safe-area-right', `${insets.right}px`)
  root.setProperty('--safe-area-bottom', `${insets.bottom}px`)
  root.setProperty('--safe-area-left', `${insets.left}px`)
  window.dispatchEvent(new Event(SAFE_AREA_CHANGE_EVENT))
}

export function useSafeArea(): void {
  useEffect(() => {
    try {
      setInsets(SafeArea.get())
      return SafeArea.subscribe({ onEvent: setInsets })
    } catch {
      return undefined
    }
  }, [])
}
