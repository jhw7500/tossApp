import { SafeArea } from '@apps-in-toss/web-framework'
import { useEffect } from 'react'

const setInsets = (insets: { top: number; right: number; bottom: number; left: number }) => {
  const root = document.documentElement.style
  root.setProperty('--safe-area-top', `${insets.top}px`)
  root.setProperty('--safe-area-right', `${insets.right}px`)
  root.setProperty('--safe-area-bottom', `${insets.bottom}px`)
  root.setProperty('--safe-area-left', `${insets.left}px`)
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
