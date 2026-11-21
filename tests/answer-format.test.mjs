import test from 'node:test'
import assert from 'node:assert/strict'
import { citationToken, unwrapMarkdown } from '../public/answer-format.mjs'

test('removes a full Markdown wrapper while preserving embedded code and math', () => {
  const content = '# Results\n\n~~~math\nx=1\n~~~'
  const wrapper = '\x60\x60\x60'
  assert.equal(unwrapMarkdown(wrapper + 'markdown\n' + content + '\n' + wrapper), content)
  assert.equal(unwrapMarkdown(wrapper + 'js\ncode()\n' + wrapper), wrapper + 'js\ncode()\n' + wrapper)
})

test('recognizes quoted references split by the model and legacy page references', () => {
  assert.deepEqual(citationToken('[[p. 12 | Evidence\nincludes the quoted sentence.]]'), {
    type: 'paperPage', raw: '[[p. 12 | Evidence\nincludes the quoted sentence.]]',
    page: 12, quote: 'Evidence\nincludes the quoted sentence.'
  })
  assert.equal(citationToken('[Page 3]').page, 3)
})
