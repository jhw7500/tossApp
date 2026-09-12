import { useEffect } from 'react'
import { SAFE_AREA_CHANGE_EVENT } from './use-safe-area.ts'

const isTextEntry = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement && element.matches('input, textarea, select, [contenteditable="true"]')

export function useKeyboardViewport(): void {
  useEffect(() => {
    let frame: number | undefined
    const viewport = window.visualViewport
    let restingHeight = viewport?.height ?? window.innerHeight
    let restingWidth = window.innerWidth
    const root = document.documentElement

    const revealActiveField = (active: HTMLElement, currentHeight: number, offsetTop: number) => {
      const field = (active.closest('.field') ?? active) as HTMLElement
      field.scrollIntoView({ block: 'center', inline: 'nearest' })
      requestAnimationFrame(() => {
        const fieldBox = field.getBoundingClientRect()
        const actionBox = document.querySelector<HTMLElement>('.page-actions')?.getBoundingClientRect()
        const visibleTop = offsetTop + 12
        const visibleBottom = Math.min(offsetTop + currentHeight, actionBox?.top ?? Number.POSITIVE_INFINITY) - 12
        if (fieldBox.bottom > visibleBottom) window.scrollBy(0, fieldBox.bottom - visibleBottom)
        else if (fieldBox.top < visibleTop) window.scrollBy(0, fieldBox.top - visibleTop)
      })
    }

    const syncViewport = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const active = document.activeElement
        const currentHeight = viewport?.height ?? window.innerHeight
        const offsetTop = viewport?.offsetTop ?? 0
        if (window.innerWidth !== restingWidth) {
          restingHeight = currentHeight
          restingWidth = window.innerWidth
        }
        const obscuredBottom = Math.max(0, window.innerHeight - currentHeight - offsetTop)
        const keyboardOpen = restingHeight - currentHeight >= 120
        root.style.setProperty('--visual-viewport-height', `${currentHeight}px`)
        root.style.setProperty('--visual-viewport-offset-top', `${offsetTop}px`)
        root.style.setProperty('--keyboard-inset-bottom', `${obscuredBottom}px`)
        root.toggleAttribute('data-keyboard-open', keyboardOpen)
        if (isTextEntry(active)) revealActiveField(active, currentHeight, offsetTop)
        if (currentHeight > restingHeight) restingHeight = currentHeight
      })
    }
    window.addEventListener('resize', syncViewport)
    window.addEventListener('focusin', syncViewport)
    window.addEventListener('focusout', syncViewport)
    window.addEventListener(SAFE_AREA_CHANGE_EVENT, syncViewport)
    viewport?.addEventListener('resize', syncViewport)
    viewport?.addEventListener('scroll', syncViewport)
    return () => {
      window.removeEventListener('resize', syncViewport)
      window.removeEventListener('focusin', syncViewport)
      window.removeEventListener('focusout', syncViewport)
      window.removeEventListener(SAFE_AREA_CHANGE_EVENT, syncViewport)
      viewport?.removeEventListener('resize', syncViewport)
      viewport?.removeEventListener('scroll', syncViewport)
      if (frame !== undefined) cancelAnimationFrame(frame)
      root.removeAttribute('data-keyboard-open')
      root.style.removeProperty('--visual-viewport-height')
      root.style.removeProperty('--visual-viewport-offset-top')
      root.style.removeProperty('--keyboard-inset-bottom')
    }
  }, [])
}
