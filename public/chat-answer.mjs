import DOMPurify from '/vendor/dompurify/dist/purify.es.mjs'
import { Marked } from '/vendor/marked/lib/marked.esm.js'
import katex from '/vendor/katex/dist/katex.mjs'
import { mathExtensions } from './markdown-math.mjs'
import { citationToken, unwrapMarkdown } from './answer-format.mjs'

function formula(tex, displayMode) {
  return katex.renderToString(tex, { displayMode, trust: false, throwOnError: false, strict: 'ignore', maxExpand: 200, maxSize: 16 })
}

const markdown = new Marked()
markdown.use({
  renderer: {
    html: () => '',
    code(token) {
      if (['math', 'latex', 'tex'].includes(token.lang?.trim().toLowerCase())) return formula(token.text, true)
      return false
    }
  },
  extensions: [...mathExtensions(formula), {
    name: 'paperPage',
    level: 'inline',
    start: source => source.search(/\[\[?(?:p{1,2}\.|pages?)\s*\d/i),
    tokenizer: citationToken,
    renderer(token) {
      const quoted = token.quote ? ' data-quote="' + encodeURIComponent(token.quote.toWellFormed()) + '"' : ''
      const action = token.quote ? 'Find evidence on PDF page ' : 'Open PDF page '
      const label = token.quote ? '[p. ' + token.page + ']' : token.raw
      return '<button type="button" class="page-citation" data-page="' + token.page + '"' + quoted +
        ' title="' + action + token.page + '">' + label + '</button>'
    }
  }]
})

let diagrams
let diagramId = 0

function loadDiagrams() {
  if (!diagrams) diagrams = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/vendor/mermaid-tiny/mermaid.tiny.js'
    script.onload = () => {
      try {
        const mermaid = globalThis.mermaid
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
          suppressErrorRendering: true, maxTextSize: 12000, maxEdges: 80,
          theme: 'neutral', flowchart: { useMaxWidth: false }
        })
        resolve(mermaid)
      } catch (error) { reject(error) }
    }
    script.onerror = () => reject(new Error('Diagram renderer could not load.'))
    document.head.append(script)
  })
  return diagrams
}

function showDiagram(image) {
  const dialog = document.getElementById('diagram-dialog')
  dialog.querySelector('.diagram-display').replaceChildren(image.cloneNode())
  dialog.showModal()
}

async function renderDiagram(code) {
  const source = code.textContent.trim()
  if (source.length > 12000 || /%%\s*\{|^\s*---\s*$|^\s*click\s/im.test(source) ||
      !/^(?:flowchart\b|graph\b|sequenceDiagram\b|stateDiagram(?:-v2)?\b|classDiagram\b|erDiagram\b|pie\b|xychart(?:-beta)?\b)/.test(source)) return
  try {
    const mermaid = await loadDiagrams()
    if (!code.isConnected) return
    const { svg } = await mermaid.render('deeppaper-diagram-' + ++diagramId, source)
    if (!code.isConnected) return
    const sanitized = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'a', 'image'],
      RETURN_DOM_FRAGMENT: true
    }).querySelector('svg')
    if (!sanitized) return
    const viewBox = sanitized.getAttribute('viewBox')?.trim().split(/\s+/)
    const width = Number(viewBox?.[2])
    if (width > 0) {
      sanitized.setAttribute('width', String(width))
      sanitized.removeAttribute('style')
    }
    const image = document.createElement('img')
    image.src = 'data:image/svg+xml,' + encodeURIComponent(sanitized.outerHTML)
    image.alt = sanitized.querySelector('title')?.textContent || 'Diagram from the reply'
    if (width > 0) {
      image.width = Math.ceil(width)
      image.style.setProperty('--diagram-readable', Math.round(width * 0.76) + 'px')
    }

    const figure = document.createElement('figure')
    figure.className = 'answer-diagram'
    const controls = document.createElement('figcaption')
    const expand = document.createElement('button')
    expand.type = 'button'
    expand.textContent = 'View larger'
    expand.onclick = () => showDiagram(image)
    controls.append(expand)
    const viewport = document.createElement('div')
    viewport.className = 'diagram-viewport'
    viewport.tabIndex = 0
    viewport.append(image)
    figure.append(viewport, controls)
    code.parentElement.replaceWith(figure)
  } catch {
    // Keep the diagram source visible when the renderer does not support it.
  }
}

export function renderAnswer(target, text, { streaming = false } = {}) {
  target.classList.add('answer-body')
  target.innerHTML = DOMPurify.sanitize(markdown.parse(unwrapMarkdown(text)), {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ['xmlns'],
    FORBID_TAGS: ['img', 'form', 'style', 'a', 'input', 'video', 'audio', 'foreignObject']
  })
  for (const block of target.querySelectorAll('table, .katex-display')) {
    const wrapper = document.createElement('div')
    wrapper.className = 'answer-overflow'
    wrapper.tabIndex = 0
    wrapper.setAttribute('aria-label', block.localName === 'table' ? 'Scrollable table' : 'Scrollable equation')
    block.replaceWith(wrapper)
    wrapper.append(block)
  }
  if (!streaming) for (const code of target.querySelectorAll('pre > code.language-mermaid')) renderDiagram(code)
}
