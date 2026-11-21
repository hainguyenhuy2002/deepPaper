const letters = value => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function locateQuote(parts, quote) {
  const needle = letters(quote)
  if (needle.length < 10) return null

  let text = ''
  const positions = []
  for (const [index, part] of parts.entries()) {
    let offset = 0
    for (const character of part) {
      const normalized = letters(character)
      text += normalized
      for (let i = 0; i < normalized.length; i++) {
        positions.push({ index, offset, end: offset + character.length })
      }
      offset += character.length
    }
  }

  const first = text.indexOf(needle)
  if (first < 0) return null
  const start = positions[first]
  const end = positions[first + needle.length - 1]
  return { start: { index: start.index, offset: start.offset }, end: { index: end.index, offset: end.end } }
}
