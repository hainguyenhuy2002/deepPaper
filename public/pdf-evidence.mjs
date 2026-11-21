import { locateQuote } from './evidence.mjs'

export function rangeRects(range, page) {
  const bounds = page.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return []
  const seen = new Set()
  return [...range.getClientRects()].flatMap(box => {
    const left = Math.max(bounds.left, box.left)
    const top = Math.max(bounds.top, box.top)
    const width = Math.min(bounds.right, box.right) - left
    const height = Math.min(bounds.bottom, box.bottom) - top
    if (width <= 0.5 || height <= 0.5) return []
    const key = [left, top, width, height].map(value => Math.round(value * 2)).join(',')
    if (seen.has(key)) return []
    seen.add(key)
    return [[(left - bounds.left) / bounds.width, (top - bounds.top) / bounds.height,
      width / bounds.width, height / bounds.height]]
  })
}

export function makeMark(rect) {
  const [left, top, width, height] = rect.map(value => value * 100 + '%')
  const mark = document.createElement('span')
  Object.assign(mark.style, { left, top, width, height })
  return mark
}

function textNodes(layer) {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  return nodes
}

export function createEvidenceNavigator({ scroll, eventBus, pageView, goToPage, currentPaper, notify }) {
  let version = 0
  let timer
  let flash

  function clear() {
    version++
    clearTimeout(timer)
    flash?.remove()
    flash = null
  }

  function waitForText(number) {
    const layer = pageView(number)?.querySelector('.textLayer')
    if (layer?.querySelector('span')) return Promise.resolve(layer)
    return new Promise(resolve => {
      const timeout = setTimeout(finish, 2400)
      const onText = event => { if (event.pageNumber === number) finish() }
      function finish() {
        clearTimeout(timeout)
        eventBus.off('textlayerrendered', onText)
        resolve(pageView(number)?.querySelector('.textLayer'))
      }
      eventBus.on('textlayerrendered', onText)
    })
  }

  async function show(number, quote = '', { automatic = false } = {}) {
    const doc = currentPaper()
    if (!doc || number < 1 || number > doc.pdf.numPages) return false
    clear()
    const attempt = version
    goToPage(number)
    if (!quote) return false

    const layer = await waitForText(number)
    if (attempt !== version || doc !== currentPaper()) return false
    const page = pageView(number)
    const nodes = layer ? textNodes(layer) : []
    const match = locateQuote(nodes.map(node => node.textContent), quote)
    if (!page || !match) {
      if (!automatic) notify('Exact wording could not be located on this page.')
      return false
    }

    const range = document.createRange()
    range.setStart(nodes[match.start.index], match.start.offset)
    range.setEnd(nodes[match.end.index], match.end.offset)
    const rects = rangeRects(range, page)
    if (!rects.length) return false
    flash = document.createElement('div')
    flash.className = 'evidence-flash'
    flash.setAttribute('aria-hidden', 'true')
    flash.append(...rects.map(makeMark))
    page.append(flash)
    const bounds = scroll.getBoundingClientRect()
    const firstY = page.getBoundingClientRect().top + rects[0][1] * page.clientHeight
    scroll.scrollTop += firstY - bounds.top - Math.min(bounds.height * 0.3, 160)
    timer = setTimeout(() => {
      flash?.remove()
      flash = null
    }, 1750)
    return true
  }

  return { clear, show }
}
