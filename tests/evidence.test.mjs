import assert from 'node:assert/strict'
import test from 'node:test'
import { locateQuote } from '../public/evidence.mjs'

test('locates the exact range across separate PDF text nodes', () => {
  assert.deepEqual(locateQuote(['Lead: Results were', ' confirmed today.', 'More text.'], 'Results were confirmed today.'), {
    start: { index: 0, offset: 6 }, end: { index: 1, offset: 16 }
  })
})

test('normalizes PDF ligatures, accents, hyphenation and spacing', () => {
  assert.deepEqual(locateQuote(['An efﬁcient infor-', 'mation café.'], 'efficient information cafe'), {
    start: { index: 0, offset: 3 }, end: { index: 1, offset: 11 }
  })
})

test('never guesses an unrelated location for a mismatched citation', () => {
  assert.equal(locateQuote(['Only the control group completed the study.'], 'The treatment group completed the study.'), null)
})
