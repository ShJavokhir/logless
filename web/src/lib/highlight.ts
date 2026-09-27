// Tiny Python tokenizer for display only (comments, strings, keywords,
// numbers, builtins). Good enough for GLM-written analysis programs.

export type Token = { t: "kw" | "str" | "com" | "num" | "fn" | "plain"; v: string }

const KW = new Set([
  "import", "from", "as", "def", "return", "for", "in", "if", "elif", "else", "while", "with", "try", "except",
  "finally", "pass", "lambda", "and", "or", "not", "is", "None", "True", "False", "class", "raise", "yield", "break", "continue",
])
const FN = new Set(["open", "len", "int", "round", "print", "range", "sorted", "sum", "min", "max", "json", "pd", "socket", "dict", "list"])

const RE = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g

export function tokenizePython(src: string): Token[] {
  const out: Token[] = []
  let last = 0
  for (const m of src.matchAll(RE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ t: "plain", v: src.slice(last, i) })
    if (m[1]) out.push({ t: "com", v: m[1] })
    else if (m[2]) out.push({ t: "str", v: m[2] })
    else if (m[3]) out.push({ t: "num", v: m[3] })
    else if (m[4]) out.push({ t: KW.has(m[4]) ? "kw" : FN.has(m[4]) ? "fn" : "plain", v: m[4] })
    last = i + m[0].length
  }
  if (last < src.length) out.push({ t: "plain", v: src.slice(last) })
  return out
}

/** Splits tokens into lines (tokens spanning newlines are split). */
export function tokenLines(src: string): Token[][] {
  const lines: Token[][] = [[]]
  for (const tok of tokenizePython(src)) {
    const parts = tok.v.split("\n")
    parts.forEach((p, i) => {
      if (i > 0) lines.push([])
      if (p) lines[lines.length - 1].push({ t: tok.t, v: p })
    })
  }
  return lines
}
