import { AnnotationMode, getDocument, GlobalWorkerOptions } from '/vendor/pdfjs-dist/build/pdf.mjs'
import { EventBus, PDFViewer } from '/vendor/pdfjs-dist/web/pdf_viewer.mjs'
import DOMPurify from '/vendor/dompurify/dist/purify.es.mjs'
import { marked } from '/vendor/marked/lib/marked.esm.js'
import { initLibrary } from './library-ui.mjs'

const base = '/vendor/pdfjs-dist/'
GlobalWorkerOptions.workerSrc = base + 'build/pdf.worker.mjs'
const byId = id => document.getElementById(id)
const scroll = byId('pdf-scroll')
const reader = scroll.closest('.reader')
const readerBody = scroll.parentElement
const toolbar = byId('toolbar')
const empty = byId('empty')
const actions = byId('selection-actions')
const noteDialog = byId('note-dialog')
const noteForm = byId('note-form')
const noteText = byId('note-text')
const modelSelect = byId('provider')
const question = byId('question')
const messages = byId('messages')

const eventBus = new EventBus()
const viewer = new PDFViewer({ container: scroll, eventBus, annotationMode: AnnotationMode.DISABLE })

let paper = null
let opening = 0
let loadingTask = null
let stored = []
let passage = null
let scope = null
let noteDraft = null
let sessions = []
let session = null
let sessionLoad = 0
let loadingSessions = false
let request = null
let toolsReady = false
let hand = false
let space = false
let drag = null
let toastTimer
let selectionFrame

async function api(url, { method = 'GET', data, signal } = {}) {
  const headers = { 'X-DeepPaper': '1' }
  if (data) headers['Content-Type'] = 'application/json'
  const response = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined, signal })
  if (response.status === 204) return null
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'The request failed (' + response.status + ').')
  return result
}

function notify(message) {
  const status = byId('reader-status')
  clearTimeout(toastTimer)
  status.textContent = message
  status.hidden = !message
  if (message) toastTimer = setTimeout(() => { status.hidden = true }, 5600)
}

function annotationURL(doc = paper) {
  return '/api/papers/' + doc.id + '/annotations'
}

function clearPassage() {
  passage = null
  actions.hidden = true
  if (scroll.contains(window.getSelection()?.anchorNode)) window.getSelection().removeAllRanges()
}

function updateControls() {
  question.disabled = !paper
  modelSelect.disabled = !toolsReady || Boolean(request)
  byId('send').disabled = !paper || !toolsReady || loadingSessions || Boolean(request)
  byId('session').disabled = !paper || loadingSessions || Boolean(request)
  byId('new-session').disabled = !paper || loadingSessions || Boolean(request)
  byId('rename-session').disabled = !session || loadingSessions || Boolean(request)
  byId('delete-session').disabled = !session || loadingSessions || Boolean(request)
  byId('new-note').disabled = !paper
  byId('summary').hidden = !paper || !toolsReady
  byId('summary').disabled = Boolean(request)
}

function closeReader() {
  opening++
  sessionLoad++
  request?.abort()
  request = null
  paper = null
  clearPassage()
  if (noteDialog.open) noteDialog.close()
  viewer.setDocument(null)
  loadingTask?.destroy().catch(() => {})
  loadingTask = null
  document.querySelector('.session-actions').open = false
  byId('reader-window').hidden = true
  byId('back-library').hidden = true
  byId('library').hidden = false
  byId('filename').textContent = ''
  byId('filename').title = ''
}

async function openReader(entry) {
  closeReader()
  const attempt = ++opening
  byId('library').hidden = true
  byId('reader-window').hidden = false
  byId('back-library').hidden = false
  scroll.hidden = true
  toolbar.hidden = true
  empty.hidden = false
  const filename = byId('filename')
  filename.textContent = entry.title
  filename.title = entry.title
  byId('ask-empty').hidden = false
  for (const message of messages.querySelectorAll('.message')) message.remove()
  question.value = ''
  session = null
  sessions = []
  stored = []
  loadingSessions = false
  setScope(null)
  renderSessions()
  renderNotes()
  notify('')

  const task = getDocument({
    url: '/api/papers/' + entry._id + '/pdf', isEvalSupported: false,
    cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/'
  })
  loadingTask = task
  let pdf
  try { pdf = await task.promise } catch (error) {
    if (attempt !== opening) return
    throw new Error(error.name === 'PasswordException' ? 'Unlock this PDF before opening it.' : 'This PDF could not be opened.')
  }
  if (attempt !== opening) return
  const doc = { id: entry._id, pdf, title: entry.title, texts: new Map() }
  paper = doc
  toolbar.hidden = false
  scroll.hidden = false
  empty.hidden = true
  viewer.setDocument(pdf)
  scroll.focus({ preventScroll: true })
  updateControls()
  await Promise.all([
    api(annotationURL(doc)).then(entries => {
      if (paper === doc) { stored = entries; redraw() }
    }).catch(error => { if (paper === doc) notify(error.message) }),
    fetchSessions(doc).catch(error => { if (paper === doc) notify(error.message) })
  ])
}

function pageView(number) { return viewer.getPageView(number - 1)?.div }

function paintHighlights(number) {
  const page = pageView(number)
  if (!page) return
  let layer = page.querySelector('.saved-highlights')
  if (!layer) {
    layer = document.createElement('div')
    layer.className = 'saved-highlights'
    layer.setAttribute('aria-hidden', 'true')
    page.append(layer)
  }
  const spans = stored.filter(item => item.page === number).flatMap(item => item.rects.map(rect => {
    const [x, y, width, height] = rect.map(value => value * 100 + '%')
    const span = document.createElement('span')
    Object.assign(span.style, { left: x, top: y, width, height })
    return span
  }))
  layer.replaceChildren(...spans)
}

function redraw() {
  const pages = new Set(stored.map(item => item.page))
  for (const layer of scroll.querySelectorAll('.saved-highlights')) {
    pages.add(Number(layer.parentElement.dataset.pageNumber))
  }
  for (const number of pages) paintHighlights(number)
  renderNotes()
}

function updatePage() {
  if (!paper || !viewer.pagesCount) return
  const page = viewer.currentPageNumber
  byId('page-number').value = page
  byId('page-number').max = viewer.pagesCount
  byId('page-total').textContent = '/ ' + viewer.pagesCount
  byId('prev').disabled = page <= 1
  byId('next').disabled = page >= viewer.pagesCount
}

function goToPage(number) {
  if (!paper || !viewer.pagesCount) return
  clearPassage()
  viewer.currentPageNumber = Math.max(1, Math.min(viewer.pagesCount, Math.round(number) || 1))
  updatePage()
}

eventBus.on('pagesinit', () => {
  viewer.currentScaleValue = 'page-width'
  updatePage()
})
eventBus.on('pagechanging', updatePage)
eventBus.on('pagerendered', ({ pageNumber }) => paintHighlights(pageNumber))
eventBus.on('scalechanging', clearPassage)
byId('prev').onclick = () => goToPage(viewer.currentPageNumber - 1)
byId('next').onclick = () => goToPage(viewer.currentPageNumber + 1)
byId('page-number').onchange = event => goToPage(event.target.valueAsNumber)
byId('zoom-in').onclick = () => { if (paper) viewer.increaseScale() }
byId('zoom-out').onclick = () => { if (paper) viewer.decreaseScale() }
byId('zoom-fit').onclick = () => { if (paper) viewer.currentScaleValue = 'page-width' }

function pageOf(node) {
  return (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('.textLayer')?.closest('.page')
}

function capturePassage() {
  actions.hidden = true
  passage = null
  const selection = window.getSelection()
  if (!paper || hand || space || !selection || selection.isCollapsed || !selection.rangeCount) return
  const range = selection.getRangeAt(0)
  const page = pageOf(range.startContainer)
  if (!page || page !== pageOf(range.endContainer) || !scroll.contains(page)) return
  const text = selection.toString().trim()
  if (!text) return
  const bounds = page.getBoundingClientRect()
  const rects = [...range.getClientRects()].flatMap(box => {
    const left = Math.max(bounds.left, box.left)
    const top = Math.max(bounds.top, box.top)
    const width = Math.min(bounds.right, box.right) - left
    const height = Math.min(bounds.bottom, box.bottom) - top
    return width > 0.5 && height > 0.5
      ? [[(left - bounds.left) / bounds.width, (top - bounds.top) / bounds.height, width / bounds.width, height / bounds.height]]
      : []
  })
  if (!rects.length) return
  passage = { page: Number(page.dataset.pageNumber), text, rects }
  const selected = range.getBoundingClientRect()
  const frame = readerBody.getBoundingClientRect()
  if (selected.bottom <= frame.top || selected.top >= frame.bottom) return
  actions.hidden = false
  const maxLeft = Math.max(4, frame.width - actions.offsetWidth - 4)
  actions.style.left = Math.max(4, Math.min(maxLeft, selected.left - frame.left)) + 'px'
  const above = selected.top - frame.top - actions.offsetHeight - 8
  actions.style.top = Math.max(4, Math.min(frame.height - actions.offsetHeight - 4,
    above >= 4 ? above : selected.bottom - frame.top + 8)) + 'px'
}

function queueSelection() {
  cancelAnimationFrame(selectionFrame)
  selectionFrame = requestAnimationFrame(capturePassage)
}

document.addEventListener('selectionchange', queueSelection)
scroll.addEventListener('scroll', queueSelection, { passive: true })
scroll.addEventListener('pointerup', queueSelection)
actions.addEventListener('pointerdown', event => event.preventDefault())

function updateHand() {
  scroll.classList.toggle('hand', hand || space)
  byId('hand-tool').setAttribute('aria-pressed', String(hand))
  byId('select-tool').setAttribute('aria-pressed', String(!hand))
  if (hand || space) clearPassage()
}

byId('hand-tool').onclick = () => { hand = true; updateHand(); scroll.focus() }
byId('select-tool').onclick = () => { hand = false; updateHand(); scroll.focus() }
scroll.addEventListener('pointerdown', event => {
  if ((!hand && !space) || event.button !== 0) return
  event.preventDefault()
  drag = { x: event.clientX, y: event.clientY, top: scroll.scrollTop, left: scroll.scrollLeft }
  scroll.setPointerCapture(event.pointerId)
  scroll.classList.add('grabbing')
})
scroll.addEventListener('pointermove', event => {
  if (!drag) return
  scroll.scrollTop = drag.top + drag.y - event.clientY
  scroll.scrollLeft = drag.left + drag.x - event.clientX
})
scroll.addEventListener('lostpointercapture', () => {
  drag = null
  scroll.classList.remove('grabbing')
})

function showTab(name, focus = false) {
  for (const tab of ['ask', 'notes']) {
    const active = tab === name
    const button = byId(tab + '-tab')
    button.setAttribute('aria-selected', String(active))
    button.tabIndex = active ? 0 : -1
    byId(tab + '-panel').hidden = !active
    if (focus && active) button.focus()
  }
}

byId('ask-tab').onclick = () => showTab('ask')
byId('notes-tab').onclick = () => showTab('notes')
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 'ask' : event.key === 'End' ? 'notes' :
    event.target.id === 'ask-tab' ? 'notes' : 'ask'
  showTab(next, true)
})

function addCardButton(card, text, action, tip = '') {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = text
  button.title = tip
  button.onclick = async () => {
    button.disabled = true
    try { await action() } catch (error) { notify(error.message) }
    finally { button.disabled = false }
  }
  card.append(button)
}

function renderNotes() {
  const list = byId('notes-list')
  byId('note-count').textContent = stored.length || ''
  list.replaceChildren()
  if (!stored.length) {
    const emptyLabel = document.createElement('p')
    emptyLabel.textContent = paper ? 'Select text to highlight it, or add a note to this page.' : 'Open a PDF to view its annotations.'
    list.append(emptyLabel)
    return
  }
  for (const entry of stored) {
    const card = document.createElement('article')
    card.className = 'note-card'
    addCardButton(card, 'Page ' + entry.page, () => {
      goToPage(entry.page)
      const mark = entry.rects[0]
      if (mark) {
        const page = pageView(entry.page)
        const offset = page.getBoundingClientRect().top - scroll.getBoundingClientRect().top
        scroll.scrollTop += offset + mark[1] * page.clientHeight - 30
      }
      scroll.focus({ preventScroll: true })
    }, 'Jump to page ' + entry.page)
    if (entry.text) {
      const quote = document.createElement('blockquote')
      quote.textContent = entry.text.length > 300 ? entry.text.slice(0, 300) + '…' : entry.text
      card.append(quote)
    }
    if (entry.note) {
      const note = document.createElement('p')
      note.textContent = entry.note
      card.append(note)
    }
    const menu = document.createElement('div')
    menu.className = 'card-actions'
    if (entry.text) addCardButton(menu, 'Ask AI', () => askPassage(entry))
    addCardButton(menu, entry.note ? 'Edit note' : 'Add note', () => showNote(entry))
    addCardButton(menu, 'Delete', async () => {
      const doc = paper
      if (!confirm('Delete this annotation?')) return
      await api(annotationURL(doc) + '/' + entry._id, { method: 'DELETE' })
      if (doc === paper) {
        stored = stored.filter(item => item._id !== entry._id)
        redraw()
      }
    })
    card.append(menu)
    list.append(card)
  }
}

async function saveHighlight() {
  if (!passage || !paper) return
  const doc = paper
  const selection = passage
  if (selection.text.length > 12000 || selection.rects.length > 500) return notify('Select a shorter passage.')
  clearPassage()
  try {
    const entry = await api(annotationURL(doc), { method: 'POST', data: selection })
    if (doc !== paper) return
    stored.push(entry)
    redraw()
    notify('Highlight saved.')
  } catch (error) { notify(error.message) }
}

function showNote(source = null) {
  if (!paper) return
  const entry = source || { page: viewer.currentPageNumber, text: '', rects: [] }
  if (entry.text.length > 12000 || entry.rects.length > 500) return notify('Select a shorter passage.')
  noteDraft = { entry, doc: paper }
  byId('note-heading').textContent = entry.note ? 'Edit note' : 'Add a note'
  byId('note-context').textContent = 'Page ' + entry.page + (entry.text ? ' · ' + entry.text.slice(0, 140) : '')
  byId('note-status').textContent = ''
  noteText.value = entry.note || ''
  noteText.required = !entry._id || !entry.rects.length
  clearPassage()
  noteDialog.showModal()
}

noteForm.onsubmit = async event => {
  event.preventDefault()
  const { entry, doc } = noteDraft
  const note = noteText.value.trim()
  const button = byId('save-note')
  if (noteText.required && !note) {
    byId('note-status').textContent = 'Write a note to save it.'
    return
  }
  button.disabled = true
  try {
    const updated = await api(annotationURL(doc) + (entry._id ? '/' + entry._id : ''), {
      method: entry._id ? 'PATCH' : 'POST',
      data: entry._id ? { note } : { ...entry, note }
    })
    if (doc !== paper) return
    if (entry._id) stored = stored.map(item => item._id === entry._id ? updated : item)
    else stored.push(updated)
    redraw()
    if (noteDialog.open && noteDraft.entry === entry) noteDialog.close()
    notify('Note saved.')
  } catch (error) { byId('note-status').textContent = error.message }
  finally { button.disabled = false }
}

byId('cancel-note').onclick = () => noteDialog.close()
byId('highlight').onclick = saveHighlight
byId('note-selection').onclick = () => { if (passage) showNote(passage) }
byId('new-note').onclick = () => showNote()

function setScope(selection) {
  scope = selection
  byId('scope-title').textContent = selection ? 'Selection · page ' + selection.page : 'Whole paper'
  byId('scope-text').textContent = selection?.text || ''
  byId('scope-text').hidden = !selection
  byId('clear-scope').hidden = !selection
}

function askPassage(selection) {
  if (!selection) return
  if (selection.text.length > 12000) return notify('Select a shorter passage.')
  setScope(selection)
  clearPassage()
  showTab('ask')
  question.focus()
  if (!question.value.trim()) question.value = 'Explain this passage in plain language.'
  question.select()
}

byId('ask-selection').onclick = () => askPassage(passage)
byId('clear-scope').onclick = () => { setScope(null); question.focus() }

async function pageText(doc, number) {
  if (doc.texts.has(number)) return doc.texts.get(number)
  const page = await doc.pdf.getPage(number)
  const text = await page.getTextContent()
  const content = text.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('').trim()
  doc.texts.set(number, content)
  return content
}

async function getContext(doc, selection, signal) {
  if (selection) {
    const pages = []
    for (const number of [selection.page - 1, selection.page, selection.page + 1]) {
      if (number < 1 || number > doc.pdf.numPages) continue
      signal.throwIfAborted()
      const text = await pageText(doc, number)
      if (text || number === selection.page) pages.push('[Page ' + number + ']\n' + (text || selection.text).slice(0, 100000))
    }
    return pages.join('\n\n')
  }
  const pages = []
  let length = 0
  for (let number = 1; number <= doc.pdf.numPages; number++) {
    signal.throwIfAborted()
    const text = await pageText(doc, number)
    if (!text) continue
    const labeled = '[Page ' + number + ']\n' + text
    length += labeled.length + 2
    if (length > 360000) throw new Error('This paper is too long for a single question. Select a passage to ask about it.')
    pages.push(labeled)
  }
  if (!pages.length) throw new Error('This PDF has no selectable text. Open a version with a text layer to ask questions.')
  return pages.join('\n\n')
}

function addMessage(label, text, className = '', markdown = false) {
  byId('ask-empty').hidden = true
  const entry = document.createElement('article')
  entry.className = 'message ' + className
  const header = document.createElement('p')
  header.className = 'message-label'
  header.textContent = label
  const body = document.createElement('div')
  if (markdown) {
    body.innerHTML = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'form', 'style', 'a', 'input', 'button', 'video', 'audio'] })
  } else body.textContent = text
  entry.append(header, body)
  messages.append(entry)
  messages.scrollTop = messages.scrollHeight
  return body
}

const sessionsURL = doc => '/api/papers/' + doc.id + '/sessions'

function renderSessions() {
  const select = byId('session')
  select.replaceChildren(new Option('Start a session', ''), ...sessions.map(item => new Option(item.title, item._id)))
  select.value = session?._id || ''
  updateControls()
}

function displaySession(entry) {
  session = entry
  for (const message of messages.querySelectorAll('.message')) message.remove()
  byId('ask-empty').hidden = Boolean(entry?.messages.length)
  for (const turn of entry?.messages || []) {
    const model = [...modelSelect.options].find(option => option.value === turn.provider)?.textContent || turn.provider || 'AI'
    if (turn.role === 'assistant') addMessage(model, turn.content, '', true)
    else addMessage(turn.page ? 'You · page ' + turn.page : 'You · whole paper', turn.content, 'reader-message')
  }
  renderSessions()
}

async function selectSession(doc, id) {
  const version = ++sessionLoad
  loadingSessions = true
  updateControls()
  try {
    const item = id ? await api(sessionsURL(doc) + '/' + id) : null
    if (paper === doc && sessionLoad === version) displaySession(item)
  } finally {
    if (sessionLoad === version) {
      loadingSessions = false
      updateControls()
    }
  }
}

async function fetchSessions(doc, id) {
  const version = ++sessionLoad
  loadingSessions = true
  updateControls()
  try {
    const list = await api(sessionsURL(doc))
    if (paper !== doc || sessionLoad !== version) return
    sessions = list
    return await selectSession(doc, id || sessions[0]?._id)
  } finally {
    if (sessionLoad === version) {
      loadingSessions = false
      updateControls()
    }
  }
}

async function createSession(doc) {
  const item = await api(sessionsURL(doc), { method: 'POST' })
  if (paper === doc) {
    sessions = [item, ...sessions]
    displaySession(item)
  }
  return item
}

byId('session').onchange = event => {
  if (paper) selectSession(paper, event.target.value).catch(error => { renderSessions(); notify(error.message) })
}
byId('new-session').onclick = async () => {
  if (!paper) return
  loadingSessions = true
  updateControls()
  try { await createSession(paper); question.focus() }
  catch (error) { notify(error.message) }
  finally { loadingSessions = false; updateControls() }
}
byId('rename-session').onclick = async () => {
  document.querySelector('.session-actions').open = false
  const title = prompt('Session name', session?.title)?.trim()
  if (!title || !paper || !session) return
  const doc = paper
  const id = session._id
  try {
    const item = await api(sessionsURL(doc) + '/' + id, { method: 'PATCH', data: { title } })
    if (paper !== doc) return
    sessions = sessions.map(entry => entry._id === id ? item : entry)
    if (session?._id === id) session.title = item.title
    renderSessions()
  } catch (error) { notify(error.message) }
}
byId('delete-session').onclick = async () => {
  document.querySelector('.session-actions').open = false
  if (!paper || !session || !confirm('Delete this session and its messages?')) return
  const doc = paper
  const id = session._id
  try {
    await api(sessionsURL(doc) + '/' + id, { method: 'DELETE' })
    if (paper === doc) await fetchSessions(doc)
  } catch (error) { notify(error.message) }
}

async function* readEvents(response) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) yield JSON.parse(line)
    }
  }
}

byId('ask-form').onsubmit = async event => {
  event.preventDefault()
  const prompt = question.value.trim()
  if (!prompt || !paper || !toolsReady || loadingSessions || request) return
  const doc = paper
  const selection = scope
  const provider = modelSelect.value
  const mode = byId('mode').value
  const name = modelSelect.selectedOptions[0].textContent
  const controller = new AbortController()
  request = controller
  question.value = ''
  updateControls()
  let pending
  let fragments = ''
  try {
    const current = session || await createSession(doc)
    controller.signal.throwIfAborted()
    addMessage(selection ? 'You · page ' + selection.page : 'You · whole paper', prompt, 'reader-message')
    pending = addMessage(name, 'Preparing paper text…')
    pending.classList.add('streaming-text')
    const context = await getContext(doc, selection, controller.signal)
    pending.textContent = 'Reading the paper…'
    const response = await fetch(sessionsURL(doc) + '/' + current._id + '/ask', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-DeepPaper': '1' },
      body: JSON.stringify({
        provider, mode, scope: selection ? 'selection' : 'paper', title: doc.title, question: prompt,
        context, selection: selection?.text, selectionPage: selection?.page
      })
    })
    if (!response.ok) throw new Error((await response.json()).error || 'Could not ask the model.')
    let saved = false
    for await (const event of readEvents(response)) {
      if (event.type === 'delta') {
        const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 70
        fragments += event.text
        pending.textContent = fragments
        if (follow) messages.scrollTop = messages.scrollHeight
      } else if (event.type === 'error') {
        throw new Error(event.error)
      } else if (event.type === 'done') {
        saved = true
        const item = event.session
        sessions = [item, ...sessions.filter(entry => entry._id !== item._id)]
        displaySession({ ...item, messages: [...current.messages, ...event.turns] })
      }
    }
    if (!saved) throw new Error('The stream closed before the answer was saved.')
  } catch (error) {
    if (controller.signal.aborted) return
    if (!pending) pending = addMessage(name, '')
    pending.parentElement.classList.add('error')
    pending.textContent = fragments ? fragments + '\n\n' + error.message : error.message
    if (!question.value.trim()) question.value = prompt
  } finally {
    if (request === controller) {
      request = null
      updateControls()
    }
  }
}

byId('summary').onclick = () => {
  setScope(null)
  question.value = 'Summarize the paper’s research question, methods, main findings, and limitations.'
  byId('ask-form').requestSubmit()
}
question.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    byId('ask-form').requestSubmit()
  }
})

const { upload } = initLibrary({ api, openReader, closeReader })
const fileInput = byId('file')
fileInput.onchange = () => {
  upload(fileInput.files[0])
  fileInput.value = ''
}
byId('choose').onclick = () => fileInput.click()
document.querySelector('.open').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    fileInput.click()
  }
})
for (const name of ['dragenter', 'dragover', 'drop']) {
  document.addEventListener(name, event => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return
    event.preventDefault()
    if (name === 'drop') {
      reader.classList.remove('dragover')
      upload(event.dataTransfer.files[0])
    } else reader.classList.add('dragover')
  })
}
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget) reader.classList.remove('dragover')
})

document.addEventListener('keydown', event => {
  if (!paper || noteDialog.open || event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
      event.target.closest?.('input, textarea, button, select, [contenteditable], .button')) return
  if (event.key === 'Escape') clearPassage()
  if (event.key === 'h' && passage) saveHighlight()
  if (event.key === 'n') showNote(passage)
  if (event.key === 'a' && passage) askPassage(passage)
  if (event.key === 'v') { hand = false; updateHand() }
  if (event.key === '+' || event.key === '=') viewer.increaseScale()
  if (event.key === '-') viewer.decreaseScale()
  if (event.code === 'Space') {
    event.preventDefault()
    space = true
    updateHand()
  }
})

function releaseSpace() {
  if (!space) return
  space = false
  updateHand()
}
document.addEventListener('keyup', event => { if (event.code === 'Space') releaseSpace() })
window.addEventListener('blur', releaseSpace)

api('/api/health').then(({ providers }) => {
  modelSelect.replaceChildren()
  if (!providers.length) modelSelect.append(new Option('No model configured'))
  for (const provider of providers) modelSelect.add(new Option(provider.name, provider.id))
  toolsReady = Boolean(providers.length)
  updateControls()
}).catch(() => {
  modelSelect.options[0].text = 'Model unavailable'
})
renderNotes()
