import { AnnotationMode, getDocument, GlobalWorkerOptions } from '/vendor/pdfjs-dist/build/pdf.mjs'
import { EventBus, PDFViewer } from '/vendor/pdfjs-dist/web/pdf_viewer.mjs'
import DOMPurify from '/vendor/dompurify/dist/purify.es.mjs'
import { marked } from '/vendor/marked/lib/marked.esm.js'

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
let history = []
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
  byId('send').disabled = !paper || !toolsReady || Boolean(request)
  byId('new-note').disabled = !paper
  byId('summary').hidden = !paper || !toolsReady
  byId('summary').disabled = Boolean(request)
}

async function openPDF(file) {
  if (!file) return
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return notify('Choose a PDF file.')
  if (file.size > 50 * 1024 * 1024) return notify('Choose a PDF under 50 MB.')
  const attempt = ++opening
  let task
  notify('Opening PDF…')
  try {
    const data = await file.arrayBuffer()
    const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
      byte => byte.toString(16).padStart(2, '0')).join('')
    task = getDocument({
      data, isEvalSupported: false, cMapPacked: true,
      cMapUrl: base + 'cmaps/', standardFontDataUrl: base + 'standard_fonts/',
      wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/'
    })
    const pdf = await task.promise
    if (attempt !== opening) { await task.destroy(); return }
    request?.abort()
    request = null
    clearPassage()
    if (noteDialog.open) noteDialog.close()
    const previous = loadingTask
    viewer.setDocument(null)
    loadingTask = task
    if (previous) previous.destroy().catch(() => {})

    const title = file.name.slice(0, 400)
    paper = { id, pdf, title, texts: new Map() }
    stored = []
    history = []
    for (const entry of messages.querySelectorAll('.message')) entry.remove()
    byId('ask-empty').hidden = false
    question.value = ''
    const filename = byId('filename')
    filename.textContent = title
    filename.title = title
    setScope(null)
    empty.hidden = true
    toolbar.hidden = false
    scroll.hidden = false
    viewer.setDocument(pdf)
    scroll.focus({ preventScroll: true })
    notify('')
    updateControls()
    renderNotes()
    const doc = paper
    const entries = await api(annotationURL(doc))
    if (paper === doc) {
      stored = entries
      redraw()
    }
  } catch (error) {
    if (task && task !== loadingTask) await task.destroy().catch(() => {})
    if (attempt === opening) {
      if (task && task === loadingTask) notify('Could not load annotations. ' + error.message)
      else notify(error.name === 'PasswordException' ? 'Unlock this PDF before opening it.' : 'This PDF could not be opened.')
    }
  }
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
    const text = await pageText(doc, selection.page)
    return '[Page ' + selection.page + ']\n' + (text || selection.text).slice(0, 120000)
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

byId('ask-form').onsubmit = async event => {
  event.preventDefault()
  const prompt = question.value.trim()
  if (!prompt || !paper || !toolsReady || request) return
  const doc = paper
  const selection = scope
  const provider = modelSelect.value
  const name = modelSelect.selectedOptions[0].textContent
  const controller = new AbortController()
  request = controller
  question.value = ''
  updateControls()
  addMessage(selection ? 'You · page ' + selection.page : 'You · whole paper', prompt, 'reader-message')
  const pending = addMessage(name, 'Preparing paper text…')
  try {
    const context = await getContext(doc, selection, controller.signal)
    pending.textContent = 'Reading and writing a reply…'
    const { answer } = await api('/api/ask', {
      method: 'POST', signal: controller.signal,
      data: {
        provider, scope: selection ? 'selection' : 'paper', title: doc.title, question: prompt,
        context, selection: selection?.text, history
      }
    })
    history = [...history, { role: 'user', content: prompt }, { role: 'assistant', content: answer.slice(0, 12000) }].slice(-8)
    pending.parentElement.remove()
    addMessage(name, answer, '', true)
  } catch (error) {
    if (controller.signal.aborted) return
    pending.parentElement.classList.add('error')
    pending.textContent = error.message
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

const fileInput = byId('file')
fileInput.onchange = () => {
  openPDF(fileInput.files[0])
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
      openPDF(event.dataTransfer.files[0])
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
