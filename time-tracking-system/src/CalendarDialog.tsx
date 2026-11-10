import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import './CalendarPolish.css'

export function CalendarDialog({ titleId, className = '', onClose, children }: {
  titleId: string
  className?: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current!
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    dialog.showModal()
    return () => {
      dialog.close()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return <dialog ref={ref} className={`modal-dialog calendar-dialog ${className}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }}>
    {children}
  </dialog>
}
