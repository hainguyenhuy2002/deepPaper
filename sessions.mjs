import { ObjectId } from 'mongodb'
import { cleanName, objectId } from './library.mjs'
import { modes } from './harness.mjs'
import { explain, providers } from './models.mjs'

export function validQuestion({ provider, scope, title, question, context, selection, selectionPage, replyExcerpt, mode = 'explain', history = [] }) {
  return typeof provider === 'string' && Object.hasOwn(modes, mode) &&
    ['paper', 'selection'].includes(scope) && typeof title === 'string' && title.length <= 400 &&
    typeof question === 'string' && question.trim() && question.length <= 4000 &&
    typeof context === 'string' && context.trim() && context.length <= 360000 &&
    (scope !== 'selection' || (typeof selection === 'string' && selection.trim() && selection.length <= 12000 &&
      (selectionPage === undefined || (Number.isInteger(selectionPage) && selectionPage > 0)))) &&
    (replyExcerpt === undefined || (typeof replyExcerpt === 'string' && replyExcerpt.trim() && replyExcerpt.length <= 5000)) &&
    Array.isArray(history) && history.length <= 8 &&
    history.every(turn => ['user', 'assistant'].includes(turn?.role) &&
      typeof turn.content === 'string' && turn.content.length <= 12000)
}

export async function mountSessions(app, db) {
  const sessions = db.collection('readingSessions')
  await sessions.createIndex({ paper: 1, updatedAt: -1 })
  const active = new Map()
  const path = '/api/papers/:paper/sessions'
  const itemPath = path + '/:session'
  const summary = { projection: { messages: 0 } }
  const match = req => ({ _id: new ObjectId(req.params.session), paper: req.params.paper })

  app.param('session', (req, res, next, id) => {
    if (!objectId(id)) return res.status(400).json({ error: 'Invalid session.' })
    next()
  })

  app.get(path, async (req, res) => {
    res.json(await sessions.find({ paper: req.params.paper }, summary).sort({ updatedAt: -1 }).toArray())
  })

  app.post(path, async (req, res) => {
    const paper = req.params.paper
    if (!await db.collection('papers').findOne({ _id: paper })) return res.status(404).json({ error: 'Paper not found.' })
    const now = new Date()
    const session = { paper, title: 'New session', version: 0, createdAt: now, updatedAt: now, messages: [] }
    const { insertedId } = await sessions.insertOne(session)
    res.status(201).json({ ...session, _id: insertedId })
  })

  app.get(itemPath, async (req, res) => {
    const session = await sessions.findOne(match(req))
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    res.json(session)
  })

  app.patch(itemPath, async (req, res) => {
    const { title, pinned } = req.body || {}
    if ((title === undefined && pinned === undefined) ||
        (title !== undefined && !cleanName(title)) ||
        (pinned !== undefined && typeof pinned !== 'boolean')) {
      return res.status(400).json({ error: 'Enter a valid session name or pin setting.' })
    }
    const changes = {}
    if (title !== undefined) changes.title = title.trim()
    if (pinned !== undefined) changes.pinned = pinned
    const updated = await sessions.findOneAndUpdate(match(req), { $set: changes }, { ...summary, returnDocument: 'after' })
    if (!updated) return res.status(404).json({ error: 'Session not found.' })
    res.json(updated)
  })

  app.delete(itemPath, async (req, res) => {
    if (active.has(req.params.session)) return res.status(409).json({ error: 'Wait for the answer to finish before deleting this session.' })
    const { deletedCount } = await sessions.deleteOne(match(req))
    res.sendStatus(deletedCount ? 204 : 404)
  })

  app.post(itemPath + '/stop', (req, res) => {
    const key = req.params.session
    const task = active.get(key)
    if (task?.id && task.paper === req.params.paper && task.id === req.body?.requestId) {
      task.controller.abort()
      active.delete(key)
    }
    res.sendStatus(204)
  })

  app.post(itemPath + '/ask', async (req, res) => {
    const input = req.body || {}
    if (!validQuestion(input)) return res.status(400).json({ error: 'The question or PDF text is missing or too long.' })
    if (!providers().some(provider => provider.id === input.provider)) {
      return res.status(503).json({ error: 'This model provider needs to be configured on the server.' })
    }
    const key = req.params.session
    const filter = match(req)
    const controller = new AbortController()
    const id = typeof input.requestId === 'string' && input.requestId.length === 36 ? input.requestId : null
    const task = { id, paper: req.params.paper, controller }
    function release() {
      if (active.get(key) === task) active.delete(key)
    }
    res.once('close', () => { controller.abort(); release() })
    const session = await sessions.findOne(filter)
    if (controller.signal.aborted) return
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (active.has(key)) return res.status(409).json({ error: 'This session already has a question in progress.' })
    if (session.messages.length >= 120) return res.status(409).json({ error: 'Start a new session to continue this paper.' })
    active.set(key, task)
    res.type('application/x-ndjson').set('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const emit = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n') }
    const heartbeat = setInterval(() => emit({ type: 'ping' }), 12000)

    try {
      const history = session.messages.slice(-8).map(({ role, content, replyExcerpt }) => ({
        role,
        content: (replyExcerpt ? 'Quoted reply: ' + JSON.stringify(replyExcerpt) + '\nQuestion: ' + content : content).slice(0, 12000)
      }))
      const answer = await explain({ ...input, history }, controller.signal, text => emit({ type: 'delta', text }))
      if (controller.signal.aborted) return
      if (Buffer.byteLength(answer) > 200000) {
        emit({ type: 'error', error: 'The reply was too long to save. Try a narrower question.' })
        return
      }
      const turns = [
        { role: 'user', content: input.question, page: input.selectionPage || null, mode: input.mode || 'explain',
          ...(input.replyExcerpt ? { replyExcerpt: input.replyExcerpt } : {}) },
        { role: 'assistant', content: answer, provider: input.provider }
      ]
      const updated = await sessions.findOneAndUpdate({ ...filter, version: session.version }, {
        $push: { messages: { $each: turns } },
        $inc: { version: 1 },
        $set: { updatedAt: new Date() }
      }, { ...summary, returnDocument: 'after' })
      if (!updated) {
        emit({ type: 'error', error: 'The session changed while answering. Reopen it to continue.' })
        return
      }
      if (session.version === 0 && updated.title === 'New session') {
        const title = input.question.trim().replace(/\s+/g, ' ').slice(0, 80)
        const named = await sessions.updateOne({ ...filter, title: 'New session' }, { $set: { title } })
        if (named.modifiedCount) updated.title = title
      }
      emit({ type: 'done', session: updated, turns })
    } catch (error) {
      emit({ type: 'error', error: error.clientMessage || 'The answer was interrupted. Try again.' })
    } finally {
      release()
      clearInterval(heartbeat)
      if (!res.destroyed) res.end()
    }
  })
}
