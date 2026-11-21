import express from 'express'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GridFSBucket, ObjectId } from 'mongodb'

export const objectId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)
export const cleanName = (value, limit = 120) => typeof value === 'string' && value.trim().length <= limit && value.trim()
const pdfLimit = 50 * 1024 * 1024

export async function mountLibrary(app, db) {
  const folders = db.collection('folders')
  const papers = db.collection('papers')
  const pdfs = new GridFSBucket(db, { bucketName: 'paperFiles' })
  await folders.createIndex({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } })
  const paperFields = { projection: { file: 0 } }
  const validFolder = async id => id === null || (objectId(id) && await folders.findOne({ _id: new ObjectId(id) }))

  app.get('/api/library', async (_req, res) => {
    const [collections, entries] = await Promise.all([
      folders.find().sort({ name: 1 }).toArray(),
      papers.find({}, paperFields).sort({ createdAt: -1 }).toArray()
    ])
    res.json({ folders: collections, papers: entries })
  })

  app.post('/api/folders', async (req, res) => {
    const name = cleanName(req.body?.name)
    if (!name) return res.status(400).json({ error: 'Enter a folder name up to 120 characters.' })
    const { insertedId } = await folders.insertOne({ name })
    res.status(201).json({ _id: insertedId, name })
  })

  app.patch('/api/folders/:folder', async (req, res) => {
    const name = cleanName(req.body?.name)
    if (!objectId(req.params.folder) || !name) return res.status(400).json({ error: 'Enter a valid folder name.' })
    const folder = await folders.findOneAndUpdate({ _id: new ObjectId(req.params.folder) }, { $set: { name } }, { returnDocument: 'after' })
    if (!folder) return res.status(404).json({ error: 'Folder not found.' })
    res.json(folder)
  })

  app.delete('/api/folders/:folder', async (req, res) => {
    const folder = req.params.folder
    if (!objectId(folder)) return res.status(400).json({ error: 'Invalid folder.' })
    const { deletedCount } = await folders.deleteOne({ _id: new ObjectId(folder) })
    if (!deletedCount) return res.status(404).json({ error: 'Folder not found.' })
    await papers.updateMany({ folder }, { $set: { folder: null } })
    res.sendStatus(204)
  })

  app.post('/api/papers', express.raw({ type: 'application/pdf', limit: pdfLimit }), async (req, res) => {
    const bytes = req.body
    const title = cleanName(req.query.title, 400)
    const folder = req.query.folder || null
    if (!title || !Buffer.isBuffer(bytes) || !bytes.subarray(0, 1024).includes('%PDF-') || !await validFolder(folder)) {
      return res.status(400).json({ error: 'Choose a valid PDF and an existing folder.' })
    }
    const _id = createHash('sha256').update(bytes).digest('hex')
    const existing = await papers.findOne({ _id }, paperFields)
    if (existing) return res.json(existing)

    const stream = pdfs.openUploadStream(title)
    try {
      await pipeline(Readable.from(bytes), stream)
      const entry = { _id, title, folder: await validFolder(folder) ? folder : null, bytes: bytes.length, createdAt: new Date() }
      await papers.insertOne({ ...entry, file: stream.id })
      res.status(201).json(entry)
    } catch (error) {
      await pdfs.delete(stream.id).catch(() => {})
      if (error.code === 11000) {
        const uploaded = await papers.findOne({ _id }, paperFields)
        if (uploaded) return res.json(uploaded)
      }
      throw error
    }
  })

  app.get('/api/papers/:paper/pdf', async (req, res, next) => {
    const entry = await papers.findOne({ _id: req.params.paper })
    if (!entry) return res.status(404).json({ error: 'Paper not found.' })
    const source = pdfs.openDownloadStream(entry.file)
    source.once('error', error => {
      if (res.headersSent) res.destroy(error)
      else next(error)
    })
    res.once('close', () => source.destroy())
    res.type('application/pdf').set('Content-Length', String(entry.bytes))
    source.pipe(res)
  })

  app.patch('/api/papers/:paper', async (req, res) => {
    const { title, folder } = req.body || {}
    const fields = {}
    if (title !== undefined) {
      fields.title = cleanName(title, 400)
      if (!fields.title) return res.status(400).json({ error: 'Enter a title up to 400 characters.' })
    }
    if (folder !== undefined) {
      if (!await validFolder(folder)) return res.status(400).json({ error: 'Folder not found.' })
      fields.folder = folder
    }
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'No changes supplied.' })
    const paper = await papers.findOneAndUpdate({ _id: req.params.paper }, { $set: fields }, { ...paperFields, returnDocument: 'after' })
    if (!paper) return res.status(404).json({ error: 'Paper not found.' })
    if (paper.folder && !await validFolder(paper.folder)) {
      await papers.updateOne({ _id: paper._id, folder: paper.folder }, { $set: { folder: null } })
      paper.folder = null
    }
    res.json(paper)
  })
  app.delete('/api/papers/:paper', async (req, res) => {
    const entry = await papers.findOneAndDelete({ _id: req.params.paper })
    if (!entry) return res.status(404).json({ error: 'Paper not found.' })
    await pdfs.delete(entry.file).catch(error => console.error('Could not remove PDF data:', error.name))
    res.sendStatus(204)
  })

}
