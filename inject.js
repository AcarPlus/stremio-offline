// Stremio arayüzüne (web.stremio.com) yerleştirilir: akış sağ tık menüsüne ve
// kartların üç nokta menüsüne "Cihaza indir" seçeneği ekler. Servis bunu hata
// ayıklama kapısı üzerinden yükler; __API__ servis adresiyle değiştirilir.
(() => {
  if (window.__offlineIndir) return
  window.__offlineIndir = true

  const API = '__API__'
  const LABEL = 'Cihaza indir (offline)'
  const MARK = 'data-offline-indir'
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>'

  // ---- bildirim
  let toastEl, toastTimer
  function toast (msg, bad) {
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.style.cssText = 'position:fixed;right:28px;bottom:28px;z-index:2147483647;max-width:520px;padding:14px 18px;border-radius:12px;font:500 15px/1.4 inherit;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.45);transition:opacity .25s;pointer-events:none;white-space:pre-wrap;word-break:break-word'
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = msg
    toastEl.style.background = bad ? '#8a2c3a' : '#3a2f7a'
    toastEl.style.opacity = '1'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0' }, bad ? 6000 : 4500)
  }

  async function post (path, body) {
    let r
    try {
      r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) })
    } catch {
      throw new Error('İndirme servisi çalışmıyor (Offline İndir kapalı)')
    }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.err || 'İstek başarısız')
    return j
  }

  // Stremio akışı oynatıcı bağlantısının içinde taşır: base64(zlib(JSON)).
  async function decodeStream (enc) {
    const bytes = Uint8Array.from(atob(decodeURIComponent(enc)), c => c.charCodeAt(0))
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).text()
    return JSON.parse(text)
  }

  function closeMenus () {
    for (const type of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
  }

  /** Stremio'nun kendi tıklama işleyicilerine ulaşmadan bizim eylemi çalıştırır. */
  function wire (el, action) {
    el.setAttribute(MARK, '1')
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
      el.addEventListener(type, e => { e.stopPropagation(); if (type === 'contextmenu') e.preventDefault() })
    }
    el.addEventListener('click', async e => {
      e.preventDefault()
      e.stopPropagation()
      try {
        const r = await action()
        if (r) toast('⬇ ' + r.message)
      } catch (err) {
        toast('✖ ' + err.message, true)
      }
      closeMenus()
    })
  }

  // ---- akış satırının sağ tık menüsü
  async function streamDownload (row) {
    const parts = row.getAttribute('href').split('/')
    const stream = await decodeStream(parts[2])
    const type = decodeURIComponent(parts[5] || '')
    const id = decodeURIComponent(parts[7] || parts[6] || '')
    let infoHash = stream.infoHash
    let fileIdx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : null
    if (!infoHash && typeof stream.url === 'string' && stream.url.startsWith(API + '/play/')) {
      const seg = stream.url.split('/')
      infoHash = seg[seg.length - 2]
      fileIdx = /^\d+$/.test(seg[seg.length - 1]) ? +seg[seg.length - 1] : null
    }
    if (!infoHash) throw new Error('Bu akış torrent değil, indirilemez')
    const trackers = [...(stream.announce || []), ...(stream.sources || [])]
      .filter(s => typeof s === 'string' && s.startsWith('tracker:')).map(s => s.slice(8))
    return post('/api/download', {
      type, id, infoHash, fileIdx, trackers,
      title: stream.description || stream.title || '',
      fileName: stream.behaviorHints && stream.behaviorHints.filename
    })
  }

  function addStreamItem (menu) {
    if (menu.querySelector(`[${MARK}]`)) return
    const row = menu.closest('a[href*="#/player/"]')
    const sample = menu.querySelector('[class*="context-menu-option-container-"]')
    if (!row || !sample) return
    const item = sample.cloneNode(true)
    item.title = LABEL
    const label = item.querySelector('[class*="context-menu-option-label-"]')
    if (label) label.textContent = LABEL
    const svg = item.querySelector('svg')
    if (svg) {
      const cls = svg.getAttribute('class')
      svg.outerHTML = ICON
      if (cls) item.querySelector('svg').setAttribute('class', cls)
    }
    wire(item, () => streamDownload(row))
    menu.appendChild(item)
  }

  // ---- kartların üç nokta menüsü
  function cardInfo () {
    const trigger = document.querySelector('button[aria-haspopup="menu"][aria-expanded="true"]')
    const link = trigger && trigger.parentElement && trigger.parentElement.querySelector('a[href^="#/detail/"]')
    if (!link) return null
    const p = link.getAttribute('href').split('?')[0].split('/').map(decodeURIComponent) // #, detail, tür, id, bölüm
    const type = p[2]
    const id = p[4] || (type === 'movie' ? p[3] : null)
    if (!id || !/^tt\d+/.test(id) || !['movie', 'series'].includes(type)) return null
    return { type, id }
  }

  function addCardItem (menu) {
    if (menu.querySelector(`[${MARK}]`)) return
    const sample = menu.querySelector('[role="menuitem"][data-value="details"]')
    const info = sample && cardInfo()
    if (!info) return
    const item = sample.cloneNode(true)
    item.title = LABEL
    item.setAttribute('data-value', 'offline-indir')
    const label = item.querySelector('span') || item
    label.textContent = '⬇ ' + LABEL
    wire(item, () => post('/api/auto', info))
    sample.after(item)
  }

  function scan () {
    for (const m of document.querySelectorAll('[class*="context-menu-content-"]')) addStreamItem(m)
    for (const m of document.querySelectorAll('[role="menu"]')) addCardItem(m)
  }

  function start () {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true })
    scan()
  }
  if (document.documentElement && document.body) start()
  else document.addEventListener('DOMContentLoaded', start)
})()
