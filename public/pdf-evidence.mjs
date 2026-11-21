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

export function createEvidenceNavigator({ scroll, pageView, goToPage, currentPaper, loadPageText, notify }) {
  let version = 0
  let timer
  let flash

  function clear() {
    version++
    clearTimeout(timer)
    flash?.remove()
    flash = null
  }

  async function locatePage(doc, number, quote) {
    const here = await loadPageText(doc, number).catch(() => '')
    if (locateQuote([here], quote)) return number
    const nearby = [number - 1, number + 1].filter(page => page > 0 && page <= doc.pdf.numPages)
    const matching = await Promise.all(nearby.map(async page => {
      const text = await loadPageText(doc, page).catch(() => '')
      return locateQuote([text], quote) ? page : null
    }))
    const exact = [...new Set([...matching.filter(Boolean), ...[...doc.texts]
      .filter(([page, text]) => page !== number && locateQuote([text], quote)).map(([page]) => page)])]
    return exact.length === 1 ? exact[0] : number
  }

  async function geometry(number, quote, current) {
    const deadline = performance.now() + 6500
    while (current() && performance.now() < deadline) {
      const page = pageView(number)
      const layer = page?.querySelector('.textLayer:not([hidden])')
      if (layer?.querySelector('span')) {
        const nodes = textNodes(layer)
        const match = locateQuote(nodes.map(node => node.textContent), quote)
        if (match) {
          const range = document.createRange()
          range.setStart(nodes[match.start.index], match.start.offset)
          range.setEnd(nodes[match.end.index], match.end.offset)
          const rects = rangeRects(range, page)
          if (rects.length) return { page, rects }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return null
  }

  async function show(number, quote = '', { automatic = false } = {}) {
    const doc = currentPaper()
    if (!doc || number < 1 || number > doc.pdf.numPages) return false
    clear()
    const attempt = version
    const current = () => attempt === version && doc === currentPaper()
    goToPage(number)
    if (!quote) return false

    const target = await locatePage(doc, number, quote)
    if (!current()) return false
    if (target !== number) goToPage(target)
    const matched = await geometry(target, quote, current)
    if (!current()) return false
    if (!matched) {
      if (!automatic) notify('The quoted wording could not be found on this page.')
      return false
    }
    const { page, rects } = matched
    flash = document.createElement('div')
    flash.className = 'evidence-flash'
    flash.setAttribute('aria-hidden', 'true')
    flash.append(...rects.map(makeMark))
    page.append(flash)
    const bounds = scroll.getBoundingClientRect()
    const pageBounds = page.getBoundingClientRect()
    const [x, y, width] = rects[0]
    const firstY = pageBounds.top + y * page.clientHeight
    const firstX = pageBounds.left + x * page.clientWidth
    scroll.scrollTop += firstY - bounds.top - Math.min(bounds.height * 0.3, 160)
    if (firstX < bounds.left || firstX + width * page.clientWidth > bounds.right) {
      scroll.scrollLeft += firstX - bounds.left - 25
    }
    timer = setTimeout(() => {
      flash?.remove()
      flash = null
    }, 1750)
    return true
  }

  return { clear, show }
}
