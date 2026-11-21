export function unwrapMarkdown(text) {
  const match = /^\s*([\x60~]{3,})(?:markdown|md)[ \t]*\r?\n([\s\S]+)\r?\n\1[ \t]*\s*$/i.exec(text)
  return match ? match[2] : text
}

export function citationToken(source) {
  const quoted = /^\[\[(?:p\.|page)\s*(\d{1,5})[ \t]*\|[ \t]*([\s\S]{1,460}?)\]\]/i.exec(source)
  if (quoted) return { type: 'paperPage', raw: quoted[0], page: Number(quoted[1]), quote: quoted[2].trim() }
  const plain = /^\[(?:p{1,2}\.|pages?)\s*(\d{1,5})(?:\s*[-–]\s*\d{1,5})?\]/i.exec(source)
  if (plain) return { type: 'paperPage', raw: plain[0], page: Number(plain[1]) }
}
