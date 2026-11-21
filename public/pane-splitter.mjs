export function installPaneSplitter(workspace, handle) {
  const stacked = matchMedia('(max-width: 750px)')
  const key = 'deeppaper-chat-split'
  const defaults = { width: 440, height: 0 }
  let sizes = { ...defaults }
  try {
    const saved = JSON.parse(localStorage.getItem(key))
    for (const axis of Object.keys(defaults)) {
      if (Number.isFinite(saved?.[axis]) && saved[axis] > 0) sizes[axis] = saved[axis]
    }
  } catch { /* The browser can deny access to storage. */ }

  function limits() {
    const axis = stacked.matches ? 'height' : 'width'
    const extent = stacked.matches ? workspace.clientHeight : workspace.clientWidth
    const min = stacked.matches ? Math.min(270, extent * 0.56) : Math.min(310, extent * 0.44)
    const max = Math.max(min, extent - (stacked.matches ? Math.min(210, extent * 0.34) : 300) - 10)
    return { axis, extent, min: Math.floor(min), max: Math.floor(max) }
  }

  const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)))

  function apply() {
    const { axis, extent, min, max } = limits()
    if (!extent) return
    const now = clamp(sizes[axis] || extent * 0.48, min, max)
    workspace.style.setProperty('--chat-' + axis, now + 'px')
    handle.setAttribute('aria-orientation', stacked.matches ? 'horizontal' : 'vertical')
    handle.setAttribute('aria-valuemin', min)
    handle.setAttribute('aria-valuemax', max)
    handle.setAttribute('aria-valuenow', now)
    handle.setAttribute('aria-valuetext', 'Chat pane ' + axis + ' ' + now + ' pixels')
  }

  function save() {
    try { localStorage.setItem(key, JSON.stringify(sizes)) } catch { /* Storage is optional. */ }
  }

  let drag = null
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return
    handle.focus({ preventScroll: true })
    drag = { id: event.pointerId, start: stacked.matches ? event.clientY : event.clientX, size: Number(handle.getAttribute('aria-valuenow')) }
    handle.setPointerCapture(event.pointerId)
    workspace.classList.add('resizing')
  })
  handle.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return
    const { axis, min, max } = limits()
    const position = stacked.matches ? event.clientY : event.clientX
    sizes[axis] = clamp(drag.size + drag.start - position, min, max)
    apply()
  })
  handle.addEventListener('lostpointercapture', () => {
    drag = null
    workspace.classList.remove('resizing')
    save()
  })
  handle.addEventListener('keydown', event => {
    const { axis, min, max } = limits()
    const now = Number(handle.getAttribute('aria-valuenow'))
    const grow = stacked.matches ? 'ArrowUp' : 'ArrowLeft'
    const shrink = stacked.matches ? 'ArrowDown' : 'ArrowRight'
    const next = event.key === grow ? now + 24 : event.key === shrink ? now - 24 :
      event.key === 'Home' ? min : event.key === 'End' ? max : null
    if (next === null) return
    event.preventDefault()
    sizes[axis] = clamp(next, min, max)
    apply()
    save()
  })
  handle.addEventListener('dblclick', () => {
    const { axis } = limits()
    sizes[axis] = defaults[axis]
    apply()
    save()
  })
  new ResizeObserver(apply).observe(workspace)
  stacked.addEventListener('change', apply)
}
