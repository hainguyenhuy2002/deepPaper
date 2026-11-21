import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export function codexStream({ instructions, prompt, history }, signal, onText) {
  const config = process.env
  const cwd = fileURLToPath(new URL('./.runtime/job', import.meta.url))
  const env = {
    PATH: config.PATH, HOME: config.HOME, CODEX_HOME: config.CODEX_HOME,
    HTTP_PROXY: config.HTTP_PROXY || config.http_proxy,
    HTTPS_PROXY: config.HTTPS_PROXY || config.https_proxy,
    ALL_PROXY: config.ALL_PROXY || config.all_proxy,
    NO_PROXY: config.NO_PROXY || config.no_proxy,
    LANG: 'C.UTF-8'
  }
  return new Promise((resolve, reject) => {
    const process = spawn(config.CODEX_BIN, [
      'app-server', '--disable', 'shell_tool', '--disable', 'unified_exec',
      '-c', 'web_search="disabled"', '-c', 'mcp_servers={}'
    ], { cwd, env, signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = createInterface({ input: process.stdout })
    let settled = false
    function finish(error) {
      if (settled) return
      settled = true
      lines.close()
      process.stdin.end()
      process.kill('SIGTERM')
      if (error) reject(error)
      else resolve()
    }
    const fail = () => finish(new Error('Codex could not complete the request. Check the server connection and Codex sign-in.'))
    function send(message, id, params) {
      process.stdin.write(JSON.stringify(id === undefined ? { method: message, params } : { id, method: message, params }) + '\n')
    }
    process.on('error', fail)
    process.on('exit', fail)
    process.stdin.on('error', fail)
    lines.on('line', line => {
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event.error && event.id !== undefined && !event.method) return fail()
      if (event.method && event.id !== undefined) {
        process.stdin.write(JSON.stringify({ id: event.id, error: { code: -32601, message: 'Tool and approval requests are disabled.' } }) + '\n')
      } else if (event.id === 1) {
        send('initialized')
        send('thread/start', 2, { cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: instructions })
      } else if (event.id === 2) {
        const prior = history.length ? 'Prior conversation (JSON)\n' + JSON.stringify(history) + '\n\n' : ''
        send('turn/start', 3, {
          threadId: event.result.thread.id, input: [{ type: 'text', text: prior + prompt, text_elements: [] }]
        })
      } else if (event.method === 'item/agentMessage/delta') {
        onText(event.params.delta)
      } else if (event.method === 'turn/completed') {
        if (event.params.turn.status === 'completed') finish()
        else fail()
      }
    })
    send('initialize', 1, { clientInfo: { name: 'deeppaper', title: 'deepPaper', version: '1.0.0' } })
  })
}
