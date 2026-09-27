// Story text cites evidence inline as [n1] / [p2]; the UI renders those as chips.

export type CitationPart = { kind: "text"; text: string } | { kind: "cite"; id: string }

/** Splits "… tools [p1]. So …" into text and evidence-id parts (n1…, p1…). */
export function splitCitations(text: string): CitationPart[] {
  const out: CitationPart[] = []
  let last = 0
  for (const m of text.matchAll(/\s?\[([np]\d{1,2})\]/g)) {
    const i = m.index ?? 0
    if (i > last) out.push({ kind: "text", text: text.slice(last, i) })
    out.push({ kind: "cite", id: m[1] })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) })
  return out
}
