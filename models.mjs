import { existsSync } from 'node:fs'
import { codexStream } from './codex-stream.mjs'
import { readingTurn } from './harness.mjs'

const config = process.env

export function providers() {
  const options = []
  if (config.CODEX_HOME && config.CODEX_BIN && existsSync(config.CODEX_BIN) &&
      existsSync(config.CODEX_HOME + '/auth.json')) options.push({ id: 'codex', name: 'Codex' })
  if (config.OPENAI_API_KEY) options.push({ id: 'openai', name: 'OpenAI' })
  if (config.ANTHROPIC_API_KEY) options.push({ id: 'claude', name: 'Claude' })
  return options
}

function modelError(message) {
  return Object.assign(new Error(message), { clientMessage: message })
}

async function* request(url, headers, body, signal) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal
    })
  } catch {
    throw modelError('Could not reach the model provider. Check the server connection and try again.')
  }
  if (response.status === 401 || response.status === 403) throw modelError('The provider rejected the server credentials.')
  if (response.status === 429) throw modelError('The provider rate or usage limit was reached.')
  if (!response.ok) throw modelError('The model provider returned an error (' + response.status + ').')

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trimEnd()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload && payload !== '[DONE]') yield JSON.parse(payload)
    }
  }
}

export async function explain(input, clientSignal, onText = () => {}) {
  const { provider, history } = input
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(120000)])
  const { instructions, prompt } = readingTurn(input)
  let answer = ''
  function append(text) {
    if (typeof text !== 'string' || !text) return
    answer += text
    onText(text)
  }
  if (provider === 'codex') {
    try {
      await codexStream({ instructions, prompt, history }, signal, append)
    } catch (error) {
      throw modelError(error.message)
    }
  } else if (provider === 'openai') {
    let completed = false
    const events = request('https://api.openai.com/v1/responses', {
      Authorization: 'Bearer ' + config.OPENAI_API_KEY
    }, {
      model: config.OPENAI_MODEL || 'gpt-5.2', store: false, instructions,
      input: [...history, { role: 'user', content: prompt }], max_output_tokens: 3200
    }, signal)
    for await (const event of events) {
      if (event.type === 'response.output_text.delta') append(event.delta)
      if (event.type === 'response.completed') completed = true
    }
    if (!completed) throw modelError('The OpenAI response ended early.')
  } else {
    let completed = false
    const events = request('https://api.anthropic.com/v1/messages', {
      'x-api-key': config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01'
    }, {
      model: config.ANTHROPIC_MODEL || 'claude-sonnet-4-6', system: instructions,
      messages: [...history, { role: 'user', content: prompt }], max_tokens: 3200
    }, signal)
    for await (const event of events) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') append(event.delta.text)
      if (event.type === 'message_stop') completed = true
    }
    if (!completed) throw modelError('The Claude response ended early.')
  }
  if (!answer.trim()) throw modelError('The model returned no explanation.')
  return answer
}
