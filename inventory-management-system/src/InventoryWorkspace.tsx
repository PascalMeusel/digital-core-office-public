import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SuiteNavItem } from '@digital-core-office/suite-ui'
import './InventoryWorkspace.css'

export function InventoryNavigation({ items, tools, label, toolsLabel, activeLabel, refresh }: { items: SuiteNavItem[]; tools: SuiteNavItem[]; label: string; toolsLabel: string; activeLabel: string; refresh: ReactNode }) {
  const links = (entries: SuiteNavItem[]) => entries.map(item => { const Icon = item.icon; return <button key={item.id} type="button" aria-current={item.active ? 'page' : undefined} onClick={event => { item.onSelect(); event.currentTarget.closest('details')?.removeAttribute('open') }}>{Icon && <Icon size={18} aria-hidden="true" />}<span>{item.label}</span></button> })
  return <aside className="inventory-sidebar">
    <nav className="inventory-desktop-navigation" aria-label={label}>{links(items)}</nav>
    <details className="inventory-mobile-navigation"><summary>{activeLabel}</summary><nav aria-label={label}>{links(items)}{links(tools)}{refresh}</nav></details>
    <div className="inventory-navigation-tools"><details className="inventory-more-menu"><summary>{toolsLabel}</summary><div>{links(tools)}</div></details>{refresh}</div>
  </aside>
}

export function WorkspaceTabs({ label, value, onChange, tabs }: { label: string; value: string; onChange: (id: string) => void; tabs: Array<{ id: string; label: string; content: ReactNode }> }) {
  const prefix = useId(), buttons = useRef<Array<HTMLButtonElement | null>>([])
  const active = tabs.some(tab => tab.id === value) ? value : tabs[0]?.id
  return <div className="workspace-sections"><div className="workspace-section-tabs" role="tablist" aria-label={label}>{tabs.map((tab, index) => <button ref={node => { buttons.current[index] = node }} type="button" role="tab" key={tab.id} id={`${prefix}-${tab.id}-tab`} aria-controls={`${prefix}-${tab.id}-panel`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} onClick={() => onChange(tab.id)} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    onChange(tabs[next].id); buttons.current[next]?.focus()
  }}>{tab.label}</button>)}</div>{tabs.map(tab => <section key={tab.id} role="tabpanel" id={`${prefix}-${tab.id}-panel`} aria-labelledby={`${prefix}-${tab.id}-tab`} hidden={active !== tab.id}>{tab.content}</section>)}</div>
}

export function WorkflowDialog({ open, onClose, de, error, children }: { open: boolean; onClose: () => void; de: boolean; error?: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), [dirty, setDirty] = useState(false), [notice, setNotice] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element || !open) return
    returnFocus.current ??= document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    element.showModal(); element.scrollTop = 0; document.body.style.overflow = 'hidden'
    // Native focus scrolling respects the dialog's scroll padding. A viewport
    // resize (including a phone keyboard) can still move an already focused
    // field behind a sticky bar without producing another focus event.
    let frame = 0
    const revealFocus = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const active = document.activeElement
        if (!(active instanceof HTMLElement) || !element.contains(active) || active.closest('.workflow-dialog-toolbar, fieldset > .form-actions')) return
        const box = (active.closest('label') ?? active).getBoundingClientRect(), dialogBox = element.getBoundingClientRect()
        const toolbar = element.querySelector('.workflow-dialog-toolbar')?.getBoundingClientRect()
        const actions = element.querySelector('fieldset > .form-actions')?.getBoundingClientRect()
        const viewport = window.visualViewport
        const top = Math.max(dialogBox.top, viewport?.offsetTop ?? 0, toolbar?.bottom ?? dialogBox.top) + 8
        const bottom = Math.min(dialogBox.bottom, viewport ? viewport.offsetTop + viewport.height : window.innerHeight, actions?.top ?? dialogBox.bottom) - 8
        if (bottom <= top) return
        if (box.top < top) element.scrollTop += box.top - top
        else if (box.bottom > bottom) element.scrollTop += Math.min(box.bottom - bottom, box.top - top)
      })
    }
    element.addEventListener('focusin', revealFocus)
    window.addEventListener('resize', revealFocus)
    window.visualViewport?.addEventListener('resize', revealFocus)
    element.querySelector<HTMLElement>('[data-dialog-focus]')?.focus()
    return () => {
      cancelAnimationFrame(frame)
      element.removeEventListener('focusin', revealFocus)
      window.removeEventListener('resize', revealFocus)
      window.visualViewport?.removeEventListener('resize', revealFocus)
      element.close(); document.body.style.overflow = overflow; if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
    }
  }, [open])
  return <dialog ref={dialog} className="inventory-workflow-dialog" aria-label={de ? 'Inventaraktion' : 'Inventory action'} onInputCapture={() => setDirty(true)} onCancel={event => { event.preventDefault(); if (dirty) setNotice(true); else onClose() }}>
    <div className="workflow-dialog-toolbar"><span>{de ? 'Inventar' : 'Inventory'}</span><button type="button" className="secondary-action" onClick={onClose}>{de ? 'Schließen' : 'Close'}</button></div>
    {error && <p className="inventory-error" role="alert">{error}</p>}
    {notice && <p role="status" className="workflow-dialog-notice">{de ? 'Deine Eingaben bleiben erhalten. Mit Abbrechen oder Schließen verwirfst du sie.' : 'Your entries are kept. Cancel or Close discards them.'}</p>}
    {children}
  </dialog>
}
