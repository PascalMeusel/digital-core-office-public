import { cloneElement, useId, type ReactElement } from 'react'

export function Field({ label, children }: { label: string; children: ReactElement }) {
  const id = useId()
  return <label><span id={id}>{label}</span>{cloneElement(children as ReactElement<{ 'aria-labelledby'?: string }>, { 'aria-labelledby': id })}</label>
}
