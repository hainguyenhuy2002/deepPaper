import { existsSync } from 'node:fs'
import { codexStream } from './codex-stream.mjs'
import { readingTurn } from './harness.mjs'
import { directMessages, directPrompt } from './direct-chat.mjs'

const config = process.env
const claudeThreadsBeta = 'message-threads-2026-08-12'

export function providers() {
  const options = []
  if (config.CODEX_HOME && config.CODEX_BIN && existsSync(config.CODEX_BIN) &&
      existsSync(config.CODEX_HOME + '/auth.json')) options.push({ id: 'codex', name: 'Codex' })
  if (config.OPENAI_API_KEY) options.push({ id: 'openai', name: 'OpenAI' })
  if (config.ANTHROPIC_API_KEY) options.push({ id: 'claude', name: 'Claude' })
  return options
}

function modelError(message, metadata = {}) {
  return Object.assign(new Error(message), { clientMessage: message, ...metadata })
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
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))).error
    throw modelError('The model provider returned an error (' + response.status + ').', {
      providerCode: error?.details?.error_code || error?.type
    })
  }

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

async function claudeReply(messages, instructions, thread, signal, append) {
  const events = request('https://api.anthropic.com/v1/messages', {
    'x-api-key': config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
    ...(thread ? { 'anthropic-beta': claudeThreadsBeta } : {})
  }, {
    model: config.ANTHROPIC_MODEL || 'claude-sonnet-4-6', messages, max_tokens: 3200,
    ...(instructions ? { system: instructions } : {}),
    ...(thread ? { thread } : {})
  }, signal)
  let completed = false
  let responseId
  for await (const event of events) {
    if (event.type === 'message_start') responseId = event.message?.id
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') append(event.delta.text)
    if (event.type === 'message_delta' && event.delta?.stop_reason === 'refusal') responseId = undefined
    if (event.type === 'message_stop') completed = true
  }
  if (!completed) throw modelError('The Claude response ended early.')
  return thread ? responseId : undefined
}

async function directClaude(next, messages, signal, append) {
  const { threadId, pending, replay } = messages
  if (threadId) {
    try {
      return await claudeReply([...pending, next], undefined,
        { type: 'continue', previous_message_id: threadId }, signal, append)
    } catch (error) {
      if (!['thread_not_found', 'thread_already_continued', 'thread_continue_in_flight',
        'thread_fingerprint_mismatch', 'thread_unsupported_request'].includes(error.providerCode)) throw error
    }
  }
  try {
    return await claudeReply([...replay, next], undefined, { type: 'create' }, signal, append)
  } catch (error) {
    if (error.providerCode !== 'thread_unsupported_request') throw error
    return claudeReply([...replay, next], undefined, undefined, signal, append)
  }
}

export async function respond(input, clientSignal, onText = () => {}, { thread, transcript = [] } = {}) {
  const { provider, history } = input
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(120000)])
  const direct = input.mode === 'llm'
  const { instructions, prompt } = direct ? { prompt: directPrompt(input) } : readingTurn(input)
  const next = { role: 'user', content: prompt }
  const messages = direct ? directMessages(transcript, thread) : null
  let answer = ''
  let threadId
  function append(text) {
    if (typeof text !== 'string' || !text) return
    answer += text
    onText(text)
  }
  if (provider === 'codex') {
    try {
      threadId = await codexStream({
        instructions, prompt, direct, history: messages?.pending || history,
        threadId: messages?.threadId, replay: messages?.replay
      }, signal, append)
    } catch (error) {
      throw modelError(error.message)
    }
  } else if (provider === 'openai') {
    let completed = false
    const events = request('https://api.openai.com/v1/responses', {
      Authorization: 'Bearer ' + config.OPENAI_API_KEY
    }, {
      model: config.OPENAI_MODEL || 'gpt-5.2', store: false, instructions,
      input: [...(messages?.replay || history), next], max_output_tokens: 3200
    }, signal)
    for await (const event of events) {
      if (event.type === 'response.output_text.delta') append(event.delta)
      if (event.type === 'response.completed') completed = true
    }
    if (!completed) throw modelError('The OpenAI response ended early.')
  } else if (direct) {
    threadId = await directClaude(next, messages, signal, append)
  } else {
    await claudeReply([...history, next], instructions, undefined, signal, append)
  }
  if (!answer.trim()) throw modelError('The model returned no reply.')
  return { answer, threadId: direct ? threadId : undefined }
}

export async function explain(...args) {
  return (await respond(...args)).answer
}
