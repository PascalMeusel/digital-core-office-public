/** Every query term must occur. Punctuation, accents and German ß are normalized. */
export function normalizeInventorySearch(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function inventorySearchScore(query: string, values: string | Array<string | undefined>) {
  const needle = normalizeInventorySearch(query)
  if (!needle) return 1
  const haystack = normalizeInventorySearch(Array.isArray(values) ? values.filter(Boolean).join(' ') : values)
  if (!needle.split(/\s+/).every(term => haystack.includes(term))) return 0
  return haystack.includes(needle) ? 2 : 1
}
