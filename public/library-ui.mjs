export function initLibrary({ api, openReader, closeReader }) {
  const $ = id => document.getElementById(id)
  let folders = []
  let papers = []
  let folder = ''
  let opening = 0
  let refreshVersion = 0
  let snapshot = ''
  let uploading = false
  const dialog = $('folder-dialog')
  const form = $('folder-form')
  let folderAction = null

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
    if (!current) folder = ''
    const known = new Set(folders.map(entry => entry._id))
    const visible = papers.filter(entry => (known.has(entry.folder) ? entry.folder : '') === folder)
    $('folder-list').replaceChildren(...folders.map(option => {
      const row = document.createElement('div')
      row.className = 'folder-row'
      const el = button(option.name, () => {
        folder = option._id
        render()
        $('folder-list').querySelector('[aria-current]')?.focus()
      })
      el.className = 'folder-select'
      if (option._id === folder) el.setAttribute('aria-current', 'true')
      row.append(el)
      const menu = document.createElement('details')
      const trigger = document.createElement('summary')
      const actions = document.createElement('div')
      menu.className = 'folder-menu'
      trigger.textContent = '···'
      trigger.title = 'Manage folder'
      trigger.setAttribute('aria-label', 'Manage folder ' + option.name)
      actions.append(button('Rename folder', () => { menu.open = false; editFolder('rename', option) }),
        button('Remove folder', () => { menu.open = false; editFolder('remove', option) }))
      menu.append(trigger, actions)
      row.append(menu)
      return row
    }))
    $('library-title').textContent = current?.name || 'Library'
    $('library-root').hidden = !current
    $('library-count').textContent = visible.length + (visible.length === 1 ? ' paper' : ' papers')
    $('folder-actions').hidden = !current
    $('library-empty').hidden = Boolean(visible.length)
    const openPaper = $('paper-list').querySelector('.paper-menu[open]')?.dataset.paper
    $('paper-list').replaceChildren(...visible.map(entry => {
      const card = document.createElement('article')
      card.className = 'paper-card'
      const title = button(entry.title, () => { window.location.hash = 'paper/' + entry._id })
      title.className = 'paper-title'
      const meta = document.createElement('span')
      meta.className = 'paper-meta'
      meta.textContent = entry.bytes < 1024 * 1024
        ? Math.max(1, Math.round(entry.bytes / 1024)) + ' KB'
        : (entry.bytes / 1024 / 1024).toFixed(1) + ' MB'
      const menu = document.createElement('details')
      menu.className = 'paper-menu'
      menu.dataset.paper = entry._id
      menu.open = entry._id === openPaper
      const trigger = document.createElement('summary')
      trigger.setAttribute('aria-label', 'Manage paper ' + entry.title)
      trigger.title = 'Manage paper'
      trigger.textContent = '···'
      const controls = document.createElement('div')
      const download = document.createElement('a')
      download.href = '/api/papers/' + entry._id + '/pdf?download=1'
      download.textContent = 'Download'
      download.download = ''
      download.onclick = () => { menu.open = false }
      controls.append(button('Rename', async () => {
        menu.open = false
        const title = prompt('Paper title', entry.title)?.trim()
        if (!title || title === entry.title) return
        await api('/api/papers/' + entry._id, { method: 'PATCH', data: { title } })
        await refresh()
      }), download, button('Delete', async () => {
        menu.open = false
        if (!confirm('Delete this PDF from the library? Its notes and sessions will be available if you add it again.')) return
        await api('/api/papers/' + entry._id, { method: 'DELETE' })
        await refresh()
        status('Paper deleted.')
      }))
      menu.append(trigger, controls)
      card.append(title, meta, menu)
      return card
    }))
  }

  async function refresh() {
    const version = ++refreshVersion
    const data = await api('/api/library')
    if (version !== refreshVersion) return
    const next = JSON.stringify(data)
    if (next === snapshot) return
    snapshot = next
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

  function editFolder(action, entry) {
    folderAction = { action, entry }
    const removing = action === 'remove'
    $('folder-dialog-title').textContent = removing ? 'Remove folder' : action === 'rename' ? 'Rename folder' : 'New folder'
    const detail = $('folder-dialog-detail')
    detail.textContent = removing ? 'Remove “' + entry.name + '”? Its papers will move to Library.' : ''
    detail.hidden = !removing
    const input = $('folder-name')
    input.value = entry?.name || ''
    input.hidden = removing
    input.required = !removing
    $('folder-name-label').hidden = removing
    $('folder-dialog-status').textContent = ''
    const save = $('save-folder')
    save.classList.toggle('danger', removing)
    save.textContent = removing ? 'Remove folder' : action === 'rename' ? 'Save name' : 'Create folder'
    dialog.showModal()
    if (removing) $('cancel-folder').focus()
    else { input.focus(); input.select() }
  }

  $('new-folder').onclick = () => editFolder('create')
  $('rename-folder').onclick = () => {
    const current = folders.find(entry => entry._id === folder)
    if (current) editFolder('rename', current)
  }
  $('delete-folder').onclick = () => {
    const current = folders.find(entry => entry._id === folder)
    if (current) editFolder('remove', current)
  }
  $('cancel-folder').onclick = () => dialog.close()
  dialog.addEventListener('cancel', event => {
    if ($('save-folder').disabled) event.preventDefault()
  })
  form.onsubmit = async event => {
    event.preventDefault()
    const { action, entry } = folderAction
    const name = $('folder-name').value.trim()
    if (action !== 'remove' && !name) {
      $('folder-dialog-status').textContent = 'Enter a folder name.'
      return
    }
    const save = $('save-folder')
    save.disabled = true
    $('cancel-folder').disabled = true
    try {
      if (action === 'create') {
        const created = await api('/api/folders', { method: 'POST', data: { name } })
        folder = created._id
      } else if (action === 'rename') {
        await api('/api/folders/' + entry._id, { method: 'PATCH', data: { name } })
      } else {
        await api('/api/folders/' + entry._id, { method: 'DELETE' })
        if (folder === entry._id) folder = ''
      }
      dialog.close()
      await refresh()
      if (action === 'remove') status('Folder removed. Its papers are in Library.')
      $('folder-list').querySelector('[aria-current]')?.focus()
    } catch (error) {
      if (dialog.open) $('folder-dialog-status').textContent = error.message
      else status(error.message)
    } finally {
      save.disabled = false
      $('cancel-folder').disabled = false
    }
  }
  $('library-root').onclick = () => {
    folder = ''
    render()
    $('library-title').focus()
  }
  document.addEventListener('click', event => {
    for (const menu of document.querySelectorAll('.folder-menu[open], .paper-menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false
    }
  })
  $('library').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    const menu = event.target.closest('.folder-menu[open], .paper-menu[open]')
    if (menu) {
      menu.open = false
      menu.querySelector('summary').focus()
    }
  })
  $('back-library').onclick = () => { window.location.hash = '' }
  window.addEventListener('hashchange', route)
  route()
  return { upload }
}
