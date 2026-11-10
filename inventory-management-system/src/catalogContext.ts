import { createContext, useContext } from 'react'
import type { InventoryStatePayload } from '../shared/inventory.ts'
export interface CatalogServices {
  state: InventoryStatePayload
  de: boolean
  read: <T>(path: string, body?: Record<string, unknown>) => Promise<T>
  mutate: (path: string, body: Record<string, unknown>) => Promise<boolean>
  busy: boolean
  suspended?: boolean
  error?: string
}
export const CatalogContext = createContext<CatalogServices | null>(null)
export function useCatalog() { const value = useContext(CatalogContext); if (!value) throw new Error('Catalog provider missing'); return value }
