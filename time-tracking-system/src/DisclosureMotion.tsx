import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import './DisclosureMotion.css'
import { disclosureTiming, prefersReducedMotion } from './useDisclosureMotion.ts'

export function AnimatedRegion({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const animation = useRef<Animation | null>(null)
  const initialized = useRef(false)
  useLayoutEffect(() => {
    const node = ref.current!
    const from = node.hidden ? 0 : node.getBoundingClientRect().height
    animation.current?.cancel()
    node.hidden = false
    node.style.overflow = ''
    const to = open ? node.getBoundingClientRect().height : 0
    if (!initialized.current || prefersReducedMotion() || from === to) {
      initialized.current = true
      node.hidden = !open
      return
    }
    node.style.overflow = 'clip'
    const next = node.animate([{ height: `${from}px` }, { height: `${to}px` }], disclosureTiming)
    animation.current = next
    next.onfinish = () => {
      node.hidden = !open
      node.style.overflow = ''
      animation.current = null
    }
  }, [open])
  useEffect(() => () => animation.current?.cancel(), [])
  return <div ref={ref} id={id} className="animated-region" inert={!open} aria-hidden={!open}>{children}</div>
}
