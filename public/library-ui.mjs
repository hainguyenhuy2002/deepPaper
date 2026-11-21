export function initLibrary({ api, openReader, closeReader }) {
  const $ = id => document.getElementById(id)
  let folders = []
  let papers = []
  let folder = ''
  let opening = 0
  let uploading = false

  function status(text) { $('library-status').textContent = text }

  function button(label, action) {
    const el = document.createElement('button')
    el.type = 'button'
    el.textContent = label
    el.onclick = () => { Promise.resolve().then(action).catch(error => status(error.message)) }
    return el
  }

  function render() {
    const current = folders.find(entry => entry._id === folder)
    if (!current && folder !== 'unfiled') folder = ''
    const known = new Set(folders.map(entry => entry._id))
    const belongs = entry => known.has(entry.folder) ? entry.folder : 'unfiled'
    const visible = folder ? papers.filter(entry => belongs(entry) === folder) : papers
    const options = [{ name: 'All papers', _id: '' }, { name: 'Unfiled', _id: 'unfiled' }, ...folders]
    $('folder-list').replaceChildren(...options.map(option => {
      const el = button(option.name, () => { folder = option._id; render() })
      if (option._id === folder) el.setAttribute('aria-current', 'true')
      return el
    }))
    $('library-title').textContent = current?.name || (folder === 'unfiled' ? 'Unfiled' : 'All papers')
    $('library-count').textContent = visible.length + (visible.length === 1 ? ' paper' : ' papers')
    $('folder-actions').hidden = !current
    $('library-empty').hidden = Boolean(visible.length)
    $('paper-list').replaceChildren(...visible.map(entry => {
      const card = document.createElement('article')
      card.className = 'paper-card'
      const title = button(entry.title, () => { window.location.hash = 'paper/' + entry._id })
      title.className = 'paper-title'
      const meta = document.createElement('span')
      meta.className = 'paper-meta'
      meta.textContent = (entry.bytes / 1024 / 1024).toFixed(1) + ' MB'
      const controls = document.createElement('div')
      controls.className = 'paper-controls'
      const move = document.createElement('select')
      move.setAttribute('aria-label', 'Move ' + entry.title + ' to folder')
      move.append(new Option('Unfiled', ''), ...folders.map(f => new Option(f.name, f._id)))
      move.value = known.has(entry.folder) ? entry.folder : ''
      move.onchange = async () => {
        move.disabled = true
        try { await api('/api/papers/' + entry._id, { method: 'PATCH', data: { folder: move.value || null } }); await refresh() }
        catch (error) { render(); status(error.message) }
      }
      controls.append(move, button('Rename', async () => {
        const title = prompt('Paper title', entry.title)?.trim()
        if (!title || title === entry.title) return
        await api('/api/papers/' + entry._id, { method: 'PATCH', data: { title } })
        await refresh()
      }))
      controls.append(button('Remove', async () => {
        if (!confirm('Remove this PDF? Its notes and sessions will be available if you add it again.')) return
        await api('/api/papers/' + entry._id, { method: 'DELETE' })
        await refresh()
      }))
      card.append(title, meta, controls)
      return card
    }))
  }

  async function refresh() {
    const data = await api('/api/library')
    folders = data.folders
    papers = data.papers
    render()
  }

  async function route() {
    const version = ++opening
    if (!/^#paper\/[a-f0-9]{64}$/.test(window.location.hash)) {
      closeReader()
      try { await refresh() } catch (error) { status(error.message) }
      return
    }
    try {
      const id = window.location.hash.slice(7)
      await refresh()
      if (version !== opening) return
      const paper = papers.find(entry => entry._id === id)
      if (!paper) throw new Error('Paper not found.')
      await openReader(paper)
    } catch (error) {
      if (version !== opening) return
      status(error.message)
      window.location.hash = ''
    }
  }

  async function upload(file) {
    if (!file || uploading) return
    if (file.size > 50 * 1024 * 1024 || (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf')) {
      window.location.hash = ''
      status('Choose a PDF under 50 MB.')
      return
    }
    uploading = true
    window.location.hash = ''
    status('Adding ' + file.name + '…')
    try {
      const query = new URLSearchParams({ title: file.name.slice(0, 400) })
      if (folders.some(entry => entry._id === folder)) query.set('folder', folder)
      const response = await fetch('/api/papers?' + query, {
        method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-DeepPaper': '1' }, body: file
      })
      const paper = await response.json()
      if (!response.ok) throw new Error(paper.error || 'Could not add this PDF.')
      status('')
      if (window.location.hash === '#paper/' + paper._id) await route()
      else window.location.hash = 'paper/' + paper._id
    } catch (error) { status(error.message) }
    finally { uploading = false }
  }

  $('new-folder').onclick = async () => {
    const name = prompt('Folder name')?.trim()
    if (!name) return
    try {
      const entry = await api('/api/folders', { method: 'POST', data: { name } })
      folder = entry._id
      await refresh()
    } catch (error) { status(error.message) }
  }
  $('rename-folder').onclick = async () => {
    const current = folders.find(entry => entry._id === folder)
    const name = current && prompt('Folder name', current.name)?.trim()
    if (!name) return
    try { await api('/api/folders/' + current._id, { method: 'PATCH', data: { name } }); await refresh() }
    catch (error) { status(error.message) }
  }
  $('delete-folder').onclick = async () => {
    if (!confirm('Remove this folder? Its papers will move to Unfiled.')) return
    try { await api('/api/folders/' + folder, { method: 'DELETE' }); await refresh() }
    catch (error) { status(error.message) }
  }
  $('back-library').onclick = () => { window.location.hash = '' }
  window.addEventListener('hashchange', route)
  route()
  return { upload }
}
