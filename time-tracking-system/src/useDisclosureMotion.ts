import { useEffect } from 'react'
export const disclosureTiming = { duration: 220, easing: 'cubic-bezier(.2, 0, .2, 1)' }
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

// One delegated listener covers native disclosures without changing their markup.
export function useDisclosureMotion() {
  useEffect(() => {
    const active = new Map<HTMLDetailsElement, { animation: Animation; expanded: boolean; overflow: string }>()
    function toggle(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return
      const summary = event.target.closest('summary')
      const details = summary?.parentElement
      if (!(details instanceof HTMLDetailsElement) || !details.closest('.app-shell')) return
      if (event.target.closest('button,a,input,select,textarea')) return
      if (prefersReducedMotion()) {
        const previous = active.get(details)
        if (previous) {
          previous.animation.cancel()
          details.open = previous.expanded
          details.style.overflow = previous.overflow
          active.delete(details)
        }
        summary!.removeAttribute('aria-expanded')
        return
      }
      event.preventDefault()
      const previous = active.get(details)
      const expanded = !(previous?.expanded ?? details.open)
      const from = details.getBoundingClientRect().height
      const overflow = previous?.overflow ?? details.style.overflow
      previous?.animation.cancel()
      details.style.overflow = overflow
      details.open = expanded
      const to = details.getBoundingClientRect().height
      details.open = true
      summary!.setAttribute('aria-expanded', String(expanded))
      details.style.overflow = 'clip'
      const animation = details.animate([{ height: `${from}px` }, { height: `${to}px` }], disclosureTiming)
      active.set(details, { animation, expanded, overflow })
      animation.onfinish = () => {
        if (active.get(details)?.animation !== animation) return
        details.open = expanded
        details.style.overflow = overflow
        active.delete(details)
      }
    }
    document.addEventListener('click', toggle)
    return () => {
      document.removeEventListener('click', toggle)
      for (const [details, value] of active) {
        value.animation.cancel()
        details.open = value.expanded
        details.style.overflow = value.overflow
      }
    }
  }, [])
}
