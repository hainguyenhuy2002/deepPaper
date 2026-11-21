import { AnnotationMode, getDocument, GlobalWorkerOptions } from '/vendor/pdfjs-dist/build/pdf.mjs'
import { EventBus, PDFViewer } from '/vendor/pdfjs-dist/web/pdf_viewer.mjs'
import { renderAnswer } from './chat-answer.mjs'
import { installPaneSplitter } from './pane-splitter.mjs'
import { initLibrary } from './library-ui.mjs'
import { locateQuote } from './evidence.mjs'
import { highlightColors } from './annotation-colors.mjs'
import { createEvidenceNavigator, makeMark, rangeRects } from './pdf-evidence.mjs'

const base = '/vendor/pdfjs-dist/'
GlobalWorkerOptions.workerSrc = base + 'build/pdf.worker.mjs'
const byId = id => document.getElementById(id)
const scroll = byId('pdf-scroll')
const reader = scroll.closest('.reader')
const readerBody = scroll.parentElement
const toolbar = byId('toolbar')
const empty = byId('empty')
const actions = byId('selection-actions')
const noteForm = byId('note-form')
const noteText = byId('note-text')
const modelSelect = byId('provider')
const question = byId('question')
const messages = byId('messages')
const replyAction = byId('ask-reply-selection')

const eventBus = new EventBus()
const viewer = new PDFViewer({ container: scroll, eventBus, annotationMode: AnnotationMode.DISABLE })

let paper = null
let opening = 0
let loadingTask = null
let stored = []
let passage = null
let clickedHighlight = null
let annotationBusy = false
let highlightColor = 'yellow'
let replySelection = ''
let sessionsVisible = false
try {
  const savedColor = localStorage.getItem('deeppaper-highlight-color')
  if (Object.hasOwn(highlightColors, savedColor)) highlightColor = savedColor
  sessionsVisible = localStorage.getItem('deeppaper-show-sessions') === 'true'
} catch { /* Preferences are optional. */ }
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
let fitTimer
let readerWidth = scroll.clientWidth
const evidence = createEvidenceNavigator({ scroll, pageView, goToPage, currentPaper: () => paper, loadPageText: pageText, notify })

installPaneSplitter(byId('reader-window'), byId('chat-splitter'))
new ResizeObserver(() => {
  if (scroll.clientWidth === readerWidth) return
  readerWidth = scroll.clientWidth
  clearTimeout(fitTimer)
  if (readerWidth) fitTimer = setTimeout(() => {
    if (paper && viewer.currentScaleValue === 'page-width') viewer.currentScaleValue = 'page-width'
  }, 130)
}).observe(scroll)

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
  clickedHighlight = null
  actions.hidden = true
  if (scroll.contains(window.getSelection()?.anchorNode)) window.getSelection().removeAllRanges()
}

function updateControls() {
  question.disabled = !paper
  modelSelect.disabled = !toolsReady || Boolean(request)
  byId('send').disabled = !paper || !toolsReady || loadingSessions || Boolean(request) || !question.value.trim()
  byId('send').hidden = Boolean(request)
  byId('stop').hidden = !request
  byId('stop').disabled = request?.controller.signal.aborted ?? true
  byId('mode').disabled = Boolean(request)
  byId('new-session').disabled = !paper || loadingSessions || Boolean(request)
  for (const button of byId('session-list').querySelectorAll('button')) {
    button.disabled = loadingSessions || Boolean(request && button.dataset.idle)
  }
  byId('new-note').disabled = !paper
  const direct = byId('mode').value === 'llm'
  question.placeholder = direct ? 'Message the model…' : 'Ask about the paper…'
  byId('summary').hidden = !paper || !toolsReady || direct
  byId('summary').disabled = Boolean(request)
}

function closeReader() {
  opening++
  sessionLoad++
  request?.controller.abort()
  request = null
  paper = null
  byId('chat-status').textContent = ''
  clearPassage()
  closeNote()
  clearReplySelection()
  evidence.clear()
  viewer.setDocument(null)
  loadingTask?.destroy().catch(() => {})
  loadingTask = null
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
    const span = makeMark(rect)
    const color = highlightColors[item.color] || highlightColors.yellow
    span.style.setProperty('--mark-color', color)
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

function placeSelection(menu, container, selected) {
  const frame = container.getBoundingClientRect()
  if (selected.bottom <= frame.top || selected.top >= frame.bottom) return
  menu.hidden = false
  const maxLeft = Math.max(4, frame.width - menu.offsetWidth - 4)
  menu.style.left = Math.max(4, Math.min(maxLeft, selected.left - frame.left)) + 'px'
  const above = selected.top - frame.top - menu.offsetHeight - 8
  menu.style.top = Math.max(4, Math.min(frame.height - menu.offsetHeight - 4,
    above >= 4 ? above : selected.bottom - frame.top + 8)) + 'px'
}

function overlappingHighlight(current) {
  const normalize = text => text.replace(/\s+/g, ' ').trim()
  return stored.findLast(item => item.page === current.page && item.rects.length &&
    normalize(item.text) === normalize(current.text) && item.rects.some(([x, y, w, h]) =>
      current.rects.some(([left, top, width, height]) =>
        left < x + w && left + width > x && top < y + h && top + height > y)))
}

function capturePassage() {
  actions.hidden = true
  passage = null
  const selection = window.getSelection()
  if (!paper || hand || space || !selection) return
  let selected
  if (!selection.isCollapsed && selection.rangeCount) {
    const range = selection.getRangeAt(0)
    const page = pageOf(range.startContainer)
    if (!page || page !== pageOf(range.endContainer) || !scroll.contains(page)) return
    const text = selection.toString().trim()
    const rects = rangeRects(range, page)
    if (!text || !rects.length) return
    const current = { page: Number(page.dataset.pageNumber), text, rects }
    passage = overlappingHighlight(current) || current
    selected = range.getBoundingClientRect()
  } else if (clickedHighlight) {
    passage = stored.find(item => item._id === clickedHighlight && item.rects.length)
    if (!passage) return
    const bounds = pageView(passage.page)?.getBoundingClientRect()
    if (!bounds) return
    const [left, top, , height] = passage.rects[0]
    selected = { left: bounds.left + left * bounds.width, top: bounds.top + top * bounds.height,
      bottom: bounds.top + (top + height) * bounds.height }
  }
  if (!passage) return
  byId('highlight').textContent = passage._id ? 'Unhighlight' : 'Highlight'
  const currentColor = passage.color || highlightColor
  for (const button of byId('highlight-colors').children) {
    button.setAttribute('aria-pressed', String(button.dataset.color === currentColor))
  }
  placeSelection(actions, readerBody, selected)
}

function clearReplySelection() {
  replySelection = ''
  replyAction.hidden = true
}

function captureReplySelection() {
  clearReplySelection()
  const selection = window.getSelection()
  if (!paper || request || !selection || selection.isCollapsed || !selection.rangeCount) return
  const range = selection.getRangeAt(0)
  const bodyOf = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.answer-body')
  const body = bodyOf(range.startContainer)
  if (!body || body !== bodyOf(range.endContainer) || !messages.contains(body) || body.classList.contains('streaming-text')) return
  const text = selection.toString().trim()
  if (!text) return
  replySelection = text
  placeSelection(replyAction, byId('reading-sidebar'), range.getBoundingClientRect())
}

function queueSelection() {
  cancelAnimationFrame(selectionFrame)
  selectionFrame = requestAnimationFrame(() => {
    capturePassage()
    captureReplySelection()
  })
}

document.addEventListener('selectionchange', queueSelection)
scroll.addEventListener('scroll', () => {
  clickedHighlight = null
  queueSelection()
}, { passive: true })
messages.addEventListener('scroll', queueSelection, { passive: true })
scroll.addEventListener('pointerup', event => {
  clickedHighlight = null
  if (!hand && !space && event.button === 0 && window.getSelection()?.isCollapsed) {
    const page = event.target.closest('.page')
    const bounds = page?.getBoundingClientRect()
    if (bounds) {
      const x = (event.clientX - bounds.left) / bounds.width
      const y = (event.clientY - bounds.top) / bounds.height
      clickedHighlight = stored.findLast(item => item.page === Number(page.dataset.pageNumber) &&
        item.rects.some(([left, top, width, height]) => x >= left && x <= left + width && y >= top && y <= top + height))?._id
    }
  }
  queueSelection()
})
messages.addEventListener('pointerup', queueSelection)
replyAction.addEventListener('pointerdown', event => event.preventDefault())
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
byId('notes-tab').onclick = () => {
  showTab('notes')
  if (paper && !stored.length && !noteDraft) showNote()
}
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
  const list = byId('note-cards')
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
    if (entry.rects.length) card.style.setProperty('--note-mark', highlightColors[entry.color] || highlightColors.yellow)
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

async function changeHighlight(color = highlightColor, toggle = false) {
  if (!passage || !paper || annotationBusy) return
  const doc = paper
  const entry = passage
  if (entry.text.length > 12000 || entry.rects.length > 500) return notify('Select a shorter passage.')
  annotationBusy = true
  highlightColor = color
  try { localStorage.setItem('deeppaper-highlight-color', color) } catch { /* Preferences are optional. */ }
  clearPassage()
  try {
    const updated = entry._id
      ? await api(annotationURL(doc) + '/' + entry._id, {
        method: 'PATCH', data: toggle ? { highlighted: false } : { color }
      })
      : await api(annotationURL(doc), { method: 'POST', data: { ...entry, color } })
    if (doc !== paper) return
    if (entry._id) {
      stored = updated
        ? stored.map(item => item._id === entry._id ? updated : item)
        : stored.filter(item => item._id !== entry._id)
    } else stored.push(updated)
    redraw()
    notify(entry._id && toggle ? 'Highlight removed.' : 'Highlight saved.')
  } catch (error) { notify(error.message) }
  finally { annotationBusy = false }
}

function closeNote() {
  noteDraft = null
  noteForm.hidden = true
}

function showNote(source = null) {
  if (!paper) return
  showTab('notes')
  if (!source && noteDraft && !noteDraft.entry._id) {
    noteText.focus()
    return
  }
  const entry = source || { page: viewer.currentPageNumber, text: '', rects: [] }
  if (entry.text.length > 12000 || entry.rects.length > 500) return notify('Select a shorter passage.')
  noteDraft = { entry, doc: paper }
  byId('note-heading').textContent = entry.note ? 'Edit note' : 'New note'
  byId('note-context').textContent = 'Page ' + entry.page + (entry.text ? ' · ' + entry.text.slice(0, 140) : '')
  byId('note-status').textContent = ''
  noteText.value = entry.note || ''
  noteText.required = !entry._id || !entry.rects.length
  clearPassage()
  noteForm.hidden = false
  noteForm.scrollIntoView({ block: 'nearest' })
  noteText.focus({ preventScroll: true })
}

noteForm.onsubmit = async event => {
  event.preventDefault()
  if (!noteDraft) return
  const draft = noteDraft
  const { entry, doc } = draft
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
      data: entry._id ? { note } : { ...entry, color: highlightColor, note }
    })
    if (doc !== paper) return
    if (entry._id) stored = stored.map(item => item._id === entry._id ? updated : item)
    else stored.push(updated)
    redraw()
    if (noteDraft === draft) {
      closeNote()
      byId('new-note').focus({ preventScroll: true })
    }
    notify('Note saved.')
  } catch (error) {
    if (noteDraft === draft) byId('note-status').textContent = error.message
  } finally { button.disabled = false }
}

byId('cancel-note').onclick = closeNote
byId('highlight').onclick = () => changeHighlight(passage?.color || highlightColor, true)
for (const [name, color] of Object.entries(highlightColors)) {
  const swatch = document.createElement('button')
  swatch.type = 'button'
  swatch.dataset.color = name
  swatch.className = 'highlight-swatch'
  swatch.title = name[0].toUpperCase() + name.slice(1) + ' highlight'
  swatch.setAttribute('aria-label', swatch.title)
  swatch.style.setProperty('--swatch', color)
  swatch.onclick = () => changeHighlight(name)
  byId('highlight-colors').append(swatch)
}
byId('note-selection').onclick = () => { if (passage) showNote(passage) }
byId('new-note').onclick = () => showNote()

function setScope(selection) {
  scope = selection
  byId('scope').hidden = !selection
  byId('scope-title').textContent = selection
    ? selection.reply ? 'Reply excerpt' : 'Selection · page ' + selection.page
    : ''
  byId('scope-text').textContent = selection?.text || ''
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
  updateControls()
}

byId('ask-selection').onclick = () => askPassage(passage)
byId('clear-scope').onclick = () => { setScope(null); question.focus() }
replyAction.onclick = () => {
  if (!replySelection) return
  if (replySelection.length > 5000) return notify('Select a shorter excerpt from the reply.')
  setScope({ text: replySelection, reply: true })
  clearReplySelection()
  window.getSelection()?.removeAllRanges()
  question.focus()
}

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

function nearBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 76
}

function finishReply(body, text) {
  body.classList.remove('streaming-text')
  renderAnswer(body, text)
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'copy-reply'
  copy.textContent = 'Copy reply'
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text)
      copy.textContent = 'Copied'
      byId('chat-status').textContent = 'Reply copied.'
      setTimeout(() => { copy.textContent = 'Copy reply' }, 1600)
    } catch {
      notify('Clipboard access is unavailable.')
    }
  }
  body.parentElement.append(copy)
}

function addMessage(label, text, className = '', markdown = false) {
  byId('ask-empty').hidden = true
  const entry = document.createElement('article')
  entry.className = 'message ' + className
  const header = document.createElement('p')
  header.className = 'message-label'
  header.textContent = label
  const body = document.createElement('div')
  entry.append(header, body)
  messages.append(entry)
  if (markdown) finishReply(body, text)
  else body.textContent = text
  messages.scrollTop = messages.scrollHeight
  return body
}

messages.addEventListener('click', event => {
  const reference = event.target.closest('.page-citation')
  if (!reference || !paper) return
  const page = Number(reference.dataset.page)
  if (page > 0 && page <= paper.pdf.numPages) {
    evidence.show(page, reference.dataset.quote ? decodeURIComponent(reference.dataset.quote) : '')
  } else notify('That page is outside this PDF.')
})

const sessionsURL = doc => '/api/papers/' + doc.id + '/sessions'

function renderSessions() {
  const atBottom = nearBottom()
  const scrollTop = messages.scrollTop
  const panel = byId('session-panel')
  const toggle = byId('toggle-sessions')
  panel.hidden = !sessionsVisible
  toggle.textContent = sessionsVisible ? 'Hide sessions' : 'Show sessions'
  toggle.setAttribute('aria-expanded', String(sessionsVisible))
  byId('current-session').textContent = session?.title || ''
  byId('current-session').title = session?.title || ''
  const list = byId('session-list')
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.sessionAction : null
  list.replaceChildren()
  if (!sessions.length) {
    const empty = document.createElement('li')
    empty.className = 'sessions-empty'
    empty.textContent = 'Saved sessions appear after you ask a question.'
    list.append(empty)
  }
  for (const item of [...sessions].sort((left, right) =>
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt))) {
    const row = document.createElement('li')
    row.className = 'session-row'
    if (item.pinned) row.classList.add('pinned-session')
    const title = document.createElement('button')
    const active = session?._id === item._id
    title.type = 'button'
    title.className = 'session-name'
    title.textContent = item.title
    title.title = item.title
    title.dataset.idle = 'true'
    title.dataset.sessionAction = item._id + '-open'
    if (active) title.setAttribute('aria-current', 'true')
    title.onclick = () => {
      if (paper && !request) selectSession(paper, item._id).catch(error => notify(error.message))
    }

    const controls = document.createElement('div')
    controls.className = 'session-row-actions'
    for (const [name, action] of [
      [item.pinned ? 'Unpin' : 'Pin', () => patchSession(item, { pinned: !item.pinned })],
      ['Rename', () => {
        const next = prompt('Session name', item.title)?.trim()
        if (next && next !== item.title) return patchSession(item, { title: next })
      }],
      ['Delete', () => removeSession(item)]
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = name
      button.setAttribute('aria-label', name + ' session ' + item.title)
      button.dataset.sessionAction = item._id + '-' + name.toLowerCase().replace('unpin', 'pin')
      if (active && name === 'Delete') button.dataset.idle = 'true'
      button.onclick = async () => {
        button.disabled = true
        try { await action() } catch (error) { notify(error.message) }
        finally { button.disabled = false }
      }
      controls.append(button)
    }
    row.append(title, controls)
    list.append(row)
  }
  updateControls()
  if (focused) {
    const next = [...list.querySelectorAll('button')].find(button => button.dataset.sessionAction === focused)
    next?.focus({ preventScroll: true })
  }
  messages.scrollTop = atBottom ? messages.scrollHeight : scrollTop
}

function userLabel(turn) {
  if (turn.replyExcerpt) return 'You · reply excerpt'
  return turn.page ? 'You · page ' + turn.page : 'You'
}

function restoreSessionSettings(entry) {
  const mode = entry?.messages.findLast(turn => turn.role === 'user')?.mode
  const choice = byId('mode')
  if (mode && [...choice.options].some(option => option.value === mode)) choice.value = mode
  const provider = entry?.messages.findLast(turn => turn.role === 'assistant')?.provider
  if (provider && [...modelSelect.options].some(option => option.value === provider)) modelSelect.value = provider
}

function displaySession(entry) {
  session = entry
  restoreSessionSettings(entry)
  clearReplySelection()
  for (const message of messages.querySelectorAll('.message')) message.remove()
  byId('ask-empty').hidden = Boolean(entry?.messages.length)
  for (const turn of entry?.messages || []) {
    const model = [...modelSelect.options].find(option => option.value === turn.provider)?.textContent || turn.provider || 'AI'
    if (turn.role === 'assistant') addMessage(model, turn.content, '', true)
    else addMessage(userLabel(turn), turn.content, 'reader-message')
  }
  renderSessions()
}

async function selectSession(doc, id) {
  const version = ++sessionLoad
  loadingSessions = true
  updateControls()
  try {
    const item = await api(sessionsURL(doc) + '/' + id)
    if (paper === doc && sessionLoad === version) {
      setScope(null)
      evidence.clear()
      displaySession(item)
    }
  } finally {
    if (sessionLoad === version) {
      loadingSessions = false
      updateControls()
    }
  }
}

async function fetchSessions(doc) {
  const version = ++sessionLoad
  loadingSessions = true
  updateControls()
  try {
    const list = await api(sessionsURL(doc))
    if (paper !== doc || sessionLoad !== version) return
    sessions = list
    if (sessions.length) await selectSession(doc, sessions[0]._id)
    else renderSessions()
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
    session = item
    renderSessions()
  }
  return item
}

async function patchSession(entry, data) {
  if (!paper) return
  const doc = paper
  const item = await api(sessionsURL(doc) + '/' + entry._id, { method: 'PATCH', data })
  if (paper !== doc) return
  sessions = sessions.map(previous => previous._id === item._id ? item : previous)
  if (session?._id === item._id) session = { ...session, ...item }
  renderSessions()
}

async function removeSession(entry) {
  if (!paper || !confirm('Delete this session and its messages?')) return
  const doc = paper
  await api(sessionsURL(doc) + '/' + entry._id, { method: 'DELETE' })
  if (paper !== doc) return
  sessions = sessions.filter(item => item._id !== entry._id)
  if (session?._id === entry._id) {
    question.value = ''
    setScope(null)
    displaySession(null)
  } else renderSessions()
  byId('toggle-sessions').focus({ preventScroll: true })
}

byId('toggle-sessions').onclick = () => {
  sessionsVisible = !sessionsVisible
  try { localStorage.setItem('deeppaper-show-sessions', String(sessionsVisible)) } catch { /* Preferences are optional. */ }
  renderSessions()
}
byId('new-session').onclick = () => {
  if (!paper || request || loadingSessions) return
  setScope(null)
  evidence.clear()
  question.value = ''
  displaySession(null)
  question.focus()
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
  const selection = scope?.reply ? null : scope
  const replyExcerpt = scope?.reply ? scope.text : undefined
  const provider = modelSelect.value
  const mode = byId('mode').value
  const name = modelSelect.selectedOptions[0].textContent
  const controller = new AbortController()
  const task = { controller, id: crypto.randomUUID(), endpoint: null, stopping: null }
  request = task
  question.value = ''
  updateControls()
  let pending
  let fragments = ''
  let paintTimer
  function paintReply() {
    paintTimer = null
    if (controller.signal.aborted || !pending?.isConnected) return
    const follow = nearBottom()
    if (fragments.length <= 28000) renderAnswer(pending, fragments, { streaming: true })
    else pending.textContent = fragments
    if (follow) messages.scrollTop = messages.scrollHeight
  }
  byId('chat-status').textContent = 'Preparing the question.'
  try {
    addMessage(userLabel({ page: selection?.page, replyExcerpt }), prompt, 'reader-message')
    pending = addMessage(name, mode === 'llm' ? 'Opening conversation…' : 'Preparing paper text…')
    pending.classList.add('streaming-text')
    const context = mode === 'llm' ? undefined : await getContext(doc, selection, controller.signal)
    controller.signal.throwIfAborted()
    const current = session || await createSession(doc)
    controller.signal.throwIfAborted()
    pending.textContent = mode === 'llm' ? 'Waiting for the reply…' : 'Reading the paper…'
    task.endpoint = sessionsURL(doc) + '/' + current._id
    const response = await fetch(task.endpoint + '/ask', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-DeepPaper': '1' },
      body: JSON.stringify({
        provider, mode, scope: selection ? 'selection' : 'paper', title: doc.title, question: prompt,
        context, requestId: task.id, selection: selection?.text, selectionPage: selection?.page, replyExcerpt
      })
    })
    if (!response.ok) throw new Error((await response.json()).error || 'Could not ask the model.')
    let saved = false
    for await (const event of readEvents(response)) {
      if (event.type === 'delta') {
        fragments += event.text
        if (!paintTimer) paintTimer = setTimeout(paintReply, 65)
      } else if (event.type === 'error') {
        throw new Error(event.error)
      } else if (event.type === 'done') {
        saved = true
        const item = event.session
        sessions = [item, ...sessions.filter(entry => entry._id !== item._id)]
        const follow = nearBottom()
        clearTimeout(paintTimer)
        session = { ...item, messages: [...current.messages, ...event.turns] }
        finishReply(pending, event.turns.at(-1).content)
        const first = [...pending.querySelectorAll('.page-citation[data-quote]')].find(reference => {
          const quote = decodeURIComponent(reference.dataset.quote)
          const source = doc.texts.get(Number(reference.dataset.page))
          if (source && locateQuote([source], quote)) return true
          return [...doc.texts.values()].filter(text => locateQuote([text], quote)).length === 1
        })
        if (first) evidence.show(Number(first.dataset.page), decodeURIComponent(first.dataset.quote), { automatic: true })
        renderSessions()
        byId('chat-status').textContent = 'Reply ready.'
        if (follow) messages.scrollTop = messages.scrollHeight
      }
    }
    if (!saved) throw new Error('The stream closed before the answer was saved.')
  } catch (error) {
    if (request !== task || paper !== doc) return
    if (!pending) pending = addMessage(name, '')
    const stopped = controller.signal.aborted
    const message = stopped ? 'Stopped before saving this reply.' : error.message
    if (!stopped) pending.parentElement.classList.add('error')
    pending.classList.remove('answer-body')
    pending.classList.add('streaming-text')
    pending.textContent = fragments ? fragments + '\n\n' + message : message
    byId('chat-status').textContent = message
    if (!question.value.trim()) question.value = prompt
  } finally {
    clearTimeout(paintTimer)
    if (task.stopping) await task.stopping
    if (request === task) {
      request = null
      updateControls()
    }
  }
}

byId('summary').onclick = () => {
  setScope(null)
  question.value = 'Summarize the paper’s research question, methods, main findings, and limitations.'
  updateControls()
  byId('ask-form').requestSubmit()
}

byId('stop').onclick = () => {
  const task = request
  if (!task) return
  if (task.endpoint) task.stopping = api(task.endpoint + '/stop', {
    method: 'POST', data: { requestId: task.id }, signal: AbortSignal.timeout(5000)
  }).catch(() => {})
  task.controller.abort()
  updateControls()
  question.focus()
}
question.addEventListener('input', updateControls)
byId('mode').addEventListener('change', updateControls)
question.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!byId('send').disabled) byId('ask-form').requestSubmit()
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
  if (!paper || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
      event.target.closest?.('input, textarea, button, select, summary, dialog, [role=separator], [contenteditable], .button')) return
  if (event.key === 'Escape') clearPassage()
  if (event.key === 'h' && passage) changeHighlight(passage.color || highlightColor, true)
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
  restoreSessionSettings(session)
  updateControls()
}).catch(() => {
  modelSelect.options[0].text = 'Model unavailable'
})
renderNotes()
