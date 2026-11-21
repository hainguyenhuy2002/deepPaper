import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { mathExtensions } from '../public/markdown-math.mjs'

function parse(text) {
  const parser = new Marked()
  parser.use({ extensions: mathExtensions((tex, display) => '<formula data-display="' + display + '">' + tex + '</formula>') })
  return parser.parse(text)
}

test('typesets common inline math delimiters', () => {
  const html = parse(String.raw`Let $x_1$ and \(\beta\) be coefficients.`)
  assert.match(html, /<formula data-display="false">x_1<\/formula>/)
  assert.match(html, /<formula data-display="false">\\beta<\/formula>/)
})

test('supports display math immediately after a Markdown paragraph', () => {
  const html = parse('The estimator is\n$$\n\\hat{x} = x_1 + x_2\n$$\nNext paragraph.')
  assert.match(html, /<\/p>\s*<formula data-display="true">\\hat\{x\} = x_1 \+ x_2<\/formula>/)
})

test('typesets display expressions with bracket delimiters', () => {
  const html = parse(String.raw`\[a^2+b^2=c^2\]`)
  assert.match(html, /<formula data-display="true">a\^2\+b\^2=c\^2<\/formula>/)
})

test('keeps price text, escaped dollars, and code readable', () => {
  const html = parse('From $10 to $20, with \\$30 saved. The literal is `$raw$`.')
  assert.doesNotMatch(html, /<formula/)
  assert.match(html, /From \$10 to \$20, with \$30 saved/)
  assert.match(html, /<code>\$raw\$<\/code>/)
})

test('does not consume math markup that has yet to arrive in the stream', () => {
  assert.doesNotMatch(parse('Estimate\n$$\n\\frac{1}{n}'), /<formula/)
})
