const blockMath = /^(?: {0,3}\$\$([\s\S]+?)\$\$| {0,3}\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/
const singleDollarBlock = /^ {0,3}\$[ \t]*\r?\n([\s\S]+?)\r?\n {0,3}\$[ \t]*(?:\n+|$)/
const inlineMath = /^(?:\\\(((?:\\(?!\))[\s\S]|[^\\\n])+?)\\\)|\$(?![$\s])((?:\\.|[^\\$\n\x60])+?)(?<!\s)\$(?![$\d]))/

export function mathExtensions(render) {
  return [
    {
      name: 'displayMath',
      level: 'block',
      start: source => source.search(/^ {0,3}(?:\$\$|\$[ \t]*$|\\\[)/m),
      tokenizer(source) {
        const match = blockMath.exec(source) || singleDollarBlock.exec(source)
        if (match) return { type: 'displayMath', raw: match[0], tex: (match[1] ?? match[2]).trim() }
      },
      renderer: token => render(token.tex, true) + '\n'
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start: source => source.search(/\\\(|\$(?![$\s])/),
      tokenizer(source) {
        const match = inlineMath.exec(source)
        if (match) return { type: 'inlineMath', raw: match[0], tex: match[1] ?? match[2] }
      },
      renderer: token => render(token.tex, false)
    }
  ]
}
