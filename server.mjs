import { createHash, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { MongoClient, ObjectId } from 'mongodb'
import { providers, explain } from './models.mjs'
import { highlightColors } from './public/annotation-colors.mjs'
import { mountLibrary } from './library.mjs'
import { mountSessions, validQuestion } from './sessions.mjs'

const { APP_USER, APP_PASSWORD, MONGODB_URI, PORT = '8787' } = process.env
if (!APP_USER || !APP_PASSWORD || !MONGODB_URI) {
  throw new Error('Set APP_USER, APP_PASSWORD, and MONGODB_URI in .env.')
}

const mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
await mongo.connect()
const annotations = mongo.db().collection('annotations')
await annotations.createIndex({ paper: 1, createdAt: 1 })
const app = express()
app.disable('x-powered-by')

const digest = value => createHash('sha256').update(value).digest()
const credentials = digest('Basic ' + Buffer.from(APP_USER + ':' + APP_PASSWORD).toString('base64'))
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  })
  if (!timingSafeEqual(digest(req.get('authorization') || ''), credentials)) {
    res.set('WWW-Authenticate', 'Basic realm="deepPaper", charset="UTF-8"')
    return res.status(401).send('Sign in to deepPaper.')
  }
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.get('X-DeepPaper') !== '1') {
    return res.status(403).json({ error: 'Open deepPaper to make changes.' })
  }
  next()
})
app.use('/api', express.json({ limit: '3mb' }))

app.get('/api/health', async (_req, res) => {
  await mongo.db().command({ ping: 1 })
  res.json({ ok: true, providers: providers() })
})

function validRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4) return false
  const [x, y, width, height] = rect
  return rect.every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
    width > 0 && height > 0 && x + width <= 1.001 && y + height <= 1.001
}

app.param('paper', (req, res, next, paper) => {
  if (!/^[a-f0-9]{64}$/.test(paper)) return res.status(400).json({ error: 'Invalid PDF ID.' })
  next()
})

app.param('annotation', (req, res, next, id) => {
  if (!/^[a-f0-9]{24}$/.test(id)) return res.status(400).json({ error: 'Invalid annotation ID.' })
  req.annotationId = new ObjectId(id)
  next()
})

const annotationPath = '/api/papers/:paper/annotations'
app.get(annotationPath, async (req, res) => {
  res.json(await annotations.find({ paper: req.params.paper }).sort({ createdAt: 1 }).toArray())
})

app.post(annotationPath, async (req, res) => {
  const { page, text, rects, note = '', color = 'yellow' } = req.body || {}
  if (!Object.hasOwn(highlightColors, color) || !Number.isInteger(page) || page < 1 || page > 10000 ||
      typeof text !== 'string' || text.length > 12000 ||
      typeof note !== 'string' || note.length > 8000 ||
      !Array.isArray(rects) || rects.length > 500 || !rects.every(validRect) ||
      (rects.length ? !text.trim() : !note.trim())) {
    return res.status(400).json({ error: 'Enter a note or select a shorter passage on one page.' })
  }
  const entry = { paper: req.params.paper, page, text, rects, color, note: note.trim(), createdAt: new Date() }
  const { insertedId } = await annotations.insertOne(entry)
  res.status(201).json({ ...entry, _id: insertedId })
})

const entryPath = annotationPath + '/:annotation'
app.patch(entryPath, async (req, res) => {
  const { note, color, highlighted } = req.body || {}
  const filter = { _id: req.annotationId, paper: req.params.paper }
  if (highlighted === false) {
    const updated = await annotations.findOneAndUpdate(filter, { $set: { rects: [] } }, { returnDocument: 'after' })
    if (!updated) return res.status(404).json({ error: 'Annotation not found.' })
    if (updated.note) return res.json(updated)
    const removed = await annotations.deleteOne({ ...filter, note: '', 'rects.0': { $exists: false } })
    if (removed.deletedCount) return res.sendStatus(204)
    const current = await annotations.findOne(filter)
    if (!current) return res.sendStatus(204)
    return res.json(current)
  }
  if ((note === undefined && color === undefined) ||
      (note !== undefined && (typeof note !== 'string' || note.length > 8000)) ||
      (color !== undefined && !Object.hasOwn(highlightColors, color))) {
    return res.status(400).json({ error: 'Enter a valid note or highlight color.' })
  }
  const changes = {}
  if (note !== undefined) changes.note = note.trim()
  if (color !== undefined) changes.color = color
  if (color !== undefined || changes.note === '') filter['rects.0'] = { $exists: true }
  const updated = await annotations.findOneAndUpdate(filter, { $set: changes }, { returnDocument: 'after' })
  if (!updated) return res.status(404).json({ error: 'Annotation not found or note is empty.' })
  res.json(updated)
})

app.delete(entryPath, async (req, res) => {
  const { deletedCount } = await annotations.deleteOne({ _id: req.annotationId, paper: req.params.paper })
  res.sendStatus(deletedCount ? 204 : 404)
})

let busy = false
app.post('/api/ask', async (req, res) => {
  const { provider, scope, title, question, context, selection, history = [] } = req.body || {}
  if (!validQuestion({ provider, scope, title, question, context, selection, history })) {
    return res.status(400).json({ error: 'The question or PDF text is missing or too long.' })
  }
  if (!providers().some(item => item.id === provider)) {
    return res.status(503).json({ error: 'This model provider needs to be configured on the server.' })
  }
  if (busy) return res.status(429).json({ error: 'A question is already running. Try again when it finishes.' })
  busy = true
  const controller = new AbortController()
  res.once('close', () => controller.abort())
  try {
    const answer = await explain({ provider, scope, title, question, context, selection, history }, controller.signal)
    res.json({ answer })
  } finally {
    busy = false
  }
})

await mountLibrary(app, mongo.db())
await mountSessions(app, mongo.db())

const directory = name => fileURLToPath(new URL(name, import.meta.url))
for (const vendor of ['pdfjs-dist', 'marked', 'dompurify', 'katex']) {
  app.use('/vendor/' + vendor, express.static(directory('./node_modules/' + vendor)))
}
app.use('/vendor/mermaid-tiny', express.static(directory('./node_modules/@mermaid-js/tiny/dist')))
app.use(express.static(directory('./public')))
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }))
app.use((error, _req, res, _next) => {
  if (res.destroyed) return
  if (error.code === 11000) return res.status(409).json({ error: 'That folder name is already in use.' })
  if (error.status === 400 || error.status === 413) {
    return res.status(error.status).json({ error: 'Invalid or oversized request.' })
  }
  if (error.clientMessage) return res.status(502).json({ error: error.clientMessage })
  console.error('Request failed:', error.name)
  res.status(500).json({ error: 'The server could not complete your request.' })
})

const server = app.listen(Number(PORT), '127.0.0.1', () => console.log('deepPaper listening on port ' + PORT))
for (const event of ['SIGTERM', 'SIGINT']) {
  process.once(event, () => server.close(async () => { await mongo.close() }))
}
