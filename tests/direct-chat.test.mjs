import test from 'node:test'
import assert from 'node:assert/strict'
import { directMessages, directPrompt } from '../direct-chat.mjs'
import { respond } from '../models.mjs'
import { validQuestion } from '../sessions.mjs'

const transcript = [
  { role: 'user', content: 'Remember violet maple.', mode: 'llm' },
  { role: 'assistant', content: 'I will.' }
]

test('LLM mode accepts an ordinary message without paper context', () => {
  const input = { provider: 'codex', mode: 'llm', scope: 'paper', title: 'P', question: 'Hello' }
  assert.ok(validQuestion(input))
  assert.equal(validQuestion({ ...input, mode: 'explain' }), false)
  assert.equal(directPrompt(input), 'Hello')
  assert.match(directPrompt({ ...input, selectionPage: 2, selection: 'Quoted text' }), /Selected PDF text \(page 2\)/)
})

test('continuation only includes exchanges after the native thread cursor', () => {
  const thread = { id: 'provider-thread', through: 2 }
  assert.deepEqual(directMessages(transcript, thread).pending, [])
  assert.deepEqual(directMessages([...transcript, { role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }], thread).pending,
    [{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }])
  assert.deepEqual(directMessages(transcript, thread).replay, [{ role: 'user', content: 'Remember violet maple.' },
    { role: 'assistant', content: 'I will.' }])
})

test('Claude continues with only the latest turn and restarts from history after expiry', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body)
    calls.push({ payload, headers: options.headers })
    if (calls.length === 2) return Response.json({ error: { details: { error_code: 'thread_not_found' } } }, { status: 404 })
    return new Response([
      { type: 'message_start', message: { id: 'msg-' + calls.length } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Violet maple.' } },
      { type: 'message_stop' }
    ].map(event => 'data: ' + JSON.stringify(event)).join('\n\n') + '\n')
  })
  const input = { provider: 'claude', mode: 'llm', question: 'What phrase did I mention?' }
  const options = { transcript, thread: { id: 'msg-original', through: 2 } }
  const signal = new AbortController().signal
  const continued = await respond(input, signal, undefined, options)
  const rebuilt = await respond(input, signal, undefined, options)
  assert.equal(continued.threadId, 'msg-1')
  assert.equal(rebuilt.threadId, 'msg-3')
  assert.equal(calls[0].headers['anthropic-beta'], 'message-threads-2026-08-12')
  assert.deepEqual(calls[0].payload.thread, { type: 'continue', previous_message_id: 'msg-original' })
  assert.deepEqual(calls[0].payload.messages, [{ role: 'user', content: input.question }])
  assert.deepEqual(calls[2].payload.thread, { type: 'create' })
  assert.equal(calls[2].payload.messages.length, 3)
  assert.ok(calls.every(({ payload }) => !Object.hasOwn(payload, 'system')))
})
