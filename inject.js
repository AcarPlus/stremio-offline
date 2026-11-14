// Stremio arayüzüne (web.stremio.com) yerleştirilir. Servis bunu hata ayıklama kapısı üzerinden
// yükler; __API__ servis adresiyle değiştirilir. Eklediği şeyler:
//  - akış sağ tık menüsüne ve kartların üç nokta menüsüne "Cihaza indir",
//  - film sayfasında "İndir", dizi sayfasında "Sezonu indir" (İndirme Merkezi gömülü pencerede),
//  - inmiş/inmekte olan içeriklerin posterinde rozet,
//  - inmiş filmin sayfasının en üstünde "Offline oynat",
//  - İndirme Merkezi'nden gelen "oynat" iletisiyle yerel dosyayı Stremio oynatıcısında açma.
// Stremio'nun sınıf adlarındaki rastgele eklere (ör. "action-buttons-container-XbKVa") bağlı
// kalınmaz: sınıfın anlamlı kökü aranır (classHas). Beklenen bir yer bulunamazsa düğmeler yedek
// konuma konur ve konsolda + ekranın sol altında küçük bir uyarı gösterilir.
// Saf kısım (saf) Node'da da çalışır: test/inject.test.mjs.
(() => {
  const API = '__API__'

  // ---------------------------------------------------------------- saf yardımcılar
  const saf = (() => {
    const SUFFIX = /^[A-Za-z0-9_-]{4,8}$/

    /** Sınıf listesi `base` ya da `base-<rastgele ek>` içeriyor mu (ek 4–8 karakter, CSS modülü karması). */
    function classHas (className, base) {
      for (const c of String(className || '').split(/\s+/)) {
        if (c === base) return true
        if (c.startsWith(base + '-') && SUFFIX.test(c.slice(base.length + 1))) return true
      }
      return false
    }

    const dec = s => { try { return decodeURIComponent(s) } catch { return s } }

    /** Stremio adres parçasını (#/…) çözer. */
    function parseRoute (hash) {
      const h = String(hash || '').replace(/^#/, '')
      const qi = h.indexOf('?')
      const pathPart = qi < 0 ? h : h.slice(0, qi)
      const q = new URLSearchParams(qi < 0 ? '' : h.slice(qi + 1))
      const p = pathPart.split('/').filter(Boolean).map(dec)
      if (p[0] === 'detail' && (p[1] === 'movie' || p[1] === 'series') && /^tt\d+$/.test(p[2] || '')) {
        const videoId = p[3] || null
        let season = null
        const m = videoId && videoId.match(/^tt\d+:(\d+):\d+$/)
        if (m) season = +m[1]
        else if (/^\d+$/.test(q.get('season') || '')) season = +q.get('season')
        return { name: 'detail', type: p[1], id: p[2], videoId, season }
      }
      if (p.length === 0 || p[0] === 'board') return { name: 'board' }
      if (p[0] === 'detail') return { name: 'detail-diger' } // kanal vb.: düğme eklenmez
      return { name: p[0] }
    }

    /** "Sezon 2", "Season 2", "Özel"/"Specials" → sezon numarası; anlaşılmazsa null. */
    function seasonFromText (text) {
      const t = String(text || '').trim()
      const m = t.match(/(?:sezon|season|staffel|saison|temporada|stagione)\s*(\d+)/i) || t.match(/^(\d+)\.?\s*(?:sezon|season)/i)
      if (m) return +m[1]
      if (/^(özel|specials?)/i.test(t)) return 0
      return null
    }

    /** İndirme Merkezi'nin gömülü kip adresi. */
    function embedUrl (api, route) {
      const base = api + '/?embed=1#/'
      if (!route || !route.id) return base
      if (route.type === 'movie') return base + 'surum/movie/' + route.id
      if (Number.isInteger(route.season)) return base + 'sezon/' + route.id + '/' + route.season
      return base + 'dizi/' + route.id
    }

    /** /api/items listesinden imdb kimliğine göre özet: kaç dosya bitti, kaç dosya iniyor, oynatılacak dosya. */
    function offlineIndex (items) {
      const map = new Map()
      const entry = (imdbId, type) => {
        let e = map.get(imdbId)
        if (!e) map.set(imdbId, e = { imdbId, type: type || null, done: 0, active: 0, doneBytes: 0, sizeBytes: 0, play: null })
        if (!e.type && type) e.type = type
        return e
      }
      for (const it of items || []) {
        if (!it) continue
        const activeState = it.state === 'downloading' || it.state === 'resolving'
        const files = (it.files || []).filter(f => f && f.selected)
        if (!files.length) {
          if (activeState && /^tt\d+$/.test(it.imdbId || '')) entry(it.imdbId, it.type).active++
          continue
        }
        for (const f of files) {
          const imdbId = String(f.videoId || it.imdbId || '').split(':')[0]
          if (!/^tt\d+$/.test(imdbId)) continue
          const e = entry(imdbId, it.type)
          if (f.complete) {
            e.done++
            const cand = {
              playUrl: f.playUrl || it.playUrl, fileName: f.name || null, fileIdx: f.idx ?? null,
              videoId: f.videoId || imdbId, imdbId, type: it.type || null,
              title: it.displayName || it.name || it.title || null, length: f.length || 0
            }
            const exact = cand.videoId === imdbId
            const best = e.play
            if (cand.playUrl && (!best || (exact && best.videoId !== imdbId) || (exact === (best.videoId === imdbId) && cand.length > best.length))) e.play = cand
          } else if (activeState) {
            e.active++
            e.doneBytes += f.doneBytes || 0
            e.sizeBytes += f.length || 0
          }
        }
      }
      return map
    }

    /** Poster rozeti: { text, kind: 'done' | 'active' } ya da null. */
    function badgeInfo (e) {
      if (!e) return null
      if (e.done > 0) return { kind: 'done', text: e.type === 'series' ? `✓ ${e.done} bölüm offline` : '✓ Offline' }
      if (e.active > 0) {
        const pct = e.sizeBytes ? Math.floor(Math.min(1, e.doneBytes / e.sizeBytes) * 100) : 0
        return { kind: 'active', text: `⬇ İniyor %${pct}` }
      }
      return null
    }

    /** Oynatıcıya verilecek Stremio akış nesnesi. */
    function streamFor (d) {
      const fileName = d.fileName || null
      return {
        url: d.playUrl,
        name: 'Offline',
        description: d.title || d.name || fileName || 'Offline',
        behaviorHints: { notWebReady: !/\.mp4$/i.test(fileName || ''), ...(fileName ? { filename: fileName } : {}) }
      }
    }

    /** Stremio akış kodlaması: base64(zlib(JSON)). */
    async function encodeStream (obj) {
      const data = new TextEncoder().encode(JSON.stringify(obj))
      const buf = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
      return btoa(bin)
    }

    async function decodeStream (enc) {
      const bytes = Uint8Array.from(atob(dec(enc)), c => c.charCodeAt(0))
      const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).text()
      return JSON.parse(text)
    }

    /** Oynatıcı adresi: #/player/<akış>/<akış eklentisi>/<meta eklentisi>/<tür>/<kimlik>/<video>. Eklenti adresi bu servistir (meta internetsiz de gelir). */
    function playerHash (encoded, api, d) {
      const vid = String(d.videoId || '')
      const id = d.imdbId || vid.split(':')[0]
      const s = encodeURIComponent(encoded)
      if (!/^tt\d+$/.test(id || '')) return '#/player/' + s
      const type = d.type === 'series' || /^tt\d+:\d+:\d+$/.test(vid) ? 'series' : 'movie'
      const man = encodeURIComponent(api + '/manifest.json')
      return `#/player/${s}/${man}/${man}/${type}/${encodeURIComponent(id)}/${encodeURIComponent(vid || id)}`
    }

    /** İndirme Merkezi'nden gelen ileti güvenilir mi (köken servis, kaynak işareti doğru, tür bilinen). */
    function isHostMessage (data, origin, apiOrigin) {
      return !!data && typeof data === 'object' && origin === apiOrigin && data.source === 'offline-indir' &&
        (data.type === 'kapat' || (data.type === 'oynat' && !!data.item && typeof data.item.playUrl === 'string' && data.item.playUrl.startsWith(apiOrigin + '/play/')))
    }

    return { classHas, parseRoute, seasonFromText, embedUrl, offlineIndex, badgeInfo, streamFor, encodeStream, decodeStream, playerHash, isHostMessage }
  })()

  if (typeof window === 'undefined' || typeof document === 'undefined') { globalThis.__offlineIndirSaf = saf; return }
  if (location.origin !== 'https://web.stremio.com') return
  if (window.__offlineIndir) return
  window.__offlineIndir = true

  const API_ORIGIN = new URL(API).origin
  const LABEL = 'Cihaza indir (offline)'
  const MARK = 'data-offline-indir'
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>'

  // ---- görünüm
  const css = `
.oi-btn{display:inline-flex;align-items:center;gap:.5em;height:3.5rem;padding:0 1.6rem;border:0;border-radius:3.5rem;font:600 1.1rem/1 inherit;font-family:inherit;color:#fff;cursor:pointer;background:#7b5bf5;box-shadow:0 4px 18px rgba(0,0,0,.35);white-space:nowrap;flex:none}
.oi-btn:hover{filter:brightness(1.12)}
.oi-btn.oi-play{background:#1f9d55}
.oi-actions{display:flex;flex-wrap:wrap;gap:1rem;margin:0 0 1rem}
.oi-dl-wrap{display:inline-flex;margin-left:1rem;align-self:center}
.oi-float{position:fixed;top:6.5rem;right:2rem;z-index:2147483000;display:flex;flex-direction:column;gap:.75rem;align-items:flex-end}
.oi-badge{position:absolute;left:.5rem;top:.5rem;z-index:5;padding:.25rem .55rem;border-radius:.5rem;font:700 .8rem/1.2 inherit;font-family:inherit;color:#fff;background:#1f9d55;box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;white-space:nowrap}
.oi-badge.oi-active{background:#7b5bf5}
.oi-overlay{position:fixed;inset:0;z-index:2147483600;background:rgba(5,4,15,.72);display:flex;align-items:center;justify-content:center}
.oi-frame{width:min(1100px,94vw);height:min(860px,92vh);border:0;border-radius:14px;background:#14121f;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.oi-warn{position:fixed;left:1rem;bottom:1rem;z-index:2147483647;max-width:28rem;padding:.6rem 2rem .6rem .8rem;border-radius:.6rem;font:500 .85rem/1.35 inherit;font-family:inherit;color:#fff;background:#8a5a12;box-shadow:0 6px 20px rgba(0,0,0,.45)}
.oi-warn button{position:absolute;right:.3rem;top:.3rem;border:0;background:none;color:#fff;cursor:pointer;font-size:1rem}`
  function addStyle () {
    if (document.getElementById('offline-indir-stil')) return
    const s = document.createElement('style')
    s.id = 'offline-indir-stil'
    s.textContent = css
    document.head.appendChild(s)
  }

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

  // ---- yapı değişikliği uyarısı (sessizce bozulmak yerine)
  const warnings = new Map()
  let warnEl
  function warnOnce (key, msg) {
    if (warnings.has(key)) return
    warnings.set(key, msg)
    console.warn('[Offline İndir] Stremio arayüzü beklenenden farklı:', msg)
    if (!warnEl) {
      warnEl = document.createElement('div')
      warnEl.className = 'oi-warn'
      warnEl.setAttribute(MARK, 'uyari')
      const close = document.createElement('button')
      close.textContent = '✕'
      close.title = 'Kapat'
      close.addEventListener('click', () => { warnEl.remove(); warnEl = null })
      warnEl.append(document.createElement('span'), close)
      document.body.appendChild(warnEl)
    }
    warnEl.firstChild.textContent = 'Offline İndir: Stremio arayüzü değişmiş görünüyor — ' + [...warnings.values()].join('; ') + '. Bazı düğmeler yedek yerde ya da eksik olabilir.'
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

  /** Sınıf kökü `base` olan öğeler (rastgele ekten bağımsız). */
  function byClass (base, root = document) {
    return [...root.querySelectorAll(`[class*="${base}"]`)].filter(el => saf.classHas(el.getAttribute('class'), base))
  }

  // Stremio önceki sayfaları gizli (display:none) tutar; yalnızca görünen sayfadaki öğe kullanılır.
  const visible = el => el.getClientRects().length > 0
  function visibleByClass (base) {
    const list = byClass(base).filter(visible)
    return list[list.length - 1] || null
  }

  function closeMenus () {
    for (const type of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
  }

  /** Stremio'nun kendi tıklama işleyicilerine ulaşmadan bizim eylemi çalıştırır. */
  function shield (el) {
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
      el.addEventListener(type, e => { e.stopPropagation(); if (type === 'contextmenu') e.preventDefault() })
    }
  }
  function wire (el, action) {
    el.setAttribute(MARK, '1')
    shield(el)
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
    const stream = await saf.decodeStream(parts[2])
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
    const r = saf.parseRoute(link.getAttribute('href'))
    if (r.name !== 'detail') return null
    return { type: r.type, id: r.videoId || (r.type === 'movie' ? r.id : null) }
  }

  function addCardItem (menu) {
    if (menu.querySelector(`[${MARK}]`)) return
    const sample = menu.querySelector('[role="menuitem"][data-value="details"]')
    const info = sample && cardInfo()
    if (!info || !info.id) return
    const item = sample.cloneNode(true)
    item.title = LABEL
    item.setAttribute('data-value', 'offline-indir')
    const label = item.querySelector('span') || item
    label.textContent = '⬇ ' + LABEL
    wire(item, () => post('/api/auto', info))
    sample.after(item)
  }

  // Sağ tıktan sonra menü hiç bulunamazsa yapı değişmiştir.
  document.addEventListener('contextmenu', e => {
    const row = e.target && e.target.closest && e.target.closest('a[href*="#/player/"]')
    if (!row) return
    setTimeout(() => {
      if (!document.querySelector('[class*="context-menu-content-"]') && !row.querySelector('[role="menu"]')) {
        warnOnce('akis-menu', 'akış sağ tık menüsü (context-menu-content) bulunamadı, "Cihaza indir" eklenemedi')
      }
    }, 900)
  }, true)

  // ---- kütüphane durumu (rozetler ve "Offline oynat" için)
  let index = new Map()
  let pollTimer = null
  async function refresh () {
    clearTimeout(pollTimer)
    try {
      if (saf.parseRoute(location.hash).name !== 'player') {
        const r = await fetch(API + '/api/items', { cache: 'no-store' })
        if (r.ok) { index = saf.offlineIndex((await r.json()).items); schedule() }
      }
    } catch { /* servis kapalı: son bilinen durum kalır */ }
    pollTimer = setTimeout(refresh, document.visibilityState === 'visible' ? 5000 : 15000)
  }

  // ---- İndirme Merkezi gömülü pencere
  let overlay = null
  function closeCenter () {
    if (!overlay) return
    overlay.wrap.remove()
    clearTimeout(overlay.timer)
    overlay = null
    refresh()
  }
  async function openCenter (route) {
    try {
      const r = await fetch(API + '/api/status', { cache: 'no-store' })
      if (!r.ok) throw new Error()
    } catch {
      toast('✖ İndirme servisi çalışmıyor (Offline İndir kapalı)', true)
      return
    }
    closeCenter()
    const url = saf.embedUrl(API, route)
    const wrap = document.createElement('div')
    wrap.className = 'oi-overlay'
    wrap.setAttribute(MARK, 'pencere')
    const frame = document.createElement('iframe')
    frame.className = 'oi-frame'
    frame.title = 'İndirme Merkezi'
    frame.src = url
    shield(wrap)
    wrap.addEventListener('click', e => { if (e.target === wrap) closeCenter() })
    wrap.appendChild(frame)
    document.body.appendChild(wrap)
    overlay = { wrap, frame, loaded: false }
    frame.addEventListener('load', () => { if (overlay && overlay.frame === frame) overlay.loaded = true })
    // Gömme engellenirse (yüklenmezse) ayrı pencerede aç.
    overlay.timer = setTimeout(() => {
      if (overlay && overlay.frame === frame && !overlay.loaded) {
        closeCenter()
        warnOnce('gomme', 'İndirme Merkezi gömülü pencerede açılamadı, ayrı pencerede açıldı')
        window.open(url.replace('?embed=1', ''), '_blank')
      }
    }, 10000)
    frame.focus()
  }
  document.addEventListener('keydown', e => {
    if (overlay && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeCenter() }
  }, true)

  async function playLocal (desc) {
    try {
      const enc = await saf.encodeStream(saf.streamFor(desc))
      location.hash = saf.playerHash(enc, API, desc)
    } catch (err) {
      toast('✖ Oynatılamadı: ' + err.message, true)
    }
  }

  window.addEventListener('message', e => {
    if (!overlay || e.source !== overlay.frame.contentWindow) return
    if (!saf.isHostMessage(e.data, e.origin, API_ORIGIN)) return
    if (e.data.type === 'kapat') closeCenter()
    else if (e.data.type === 'oynat') { closeCenter(); playLocal(e.data.item) }
  })

  // ---- film / dizi sayfası düğmeleri
  function makeBtn (key, text, cls, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'oi-btn' + (cls ? ' ' + cls : '')
    b.setAttribute(MARK, key)
    b.textContent = text
    shield(b)
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick() })
    return b
  }

  function currentSeason (route) {
    if (Number.isInteger(route.season)) return route.season
    for (const bar of byClass('seasons-bar').filter(visible)) {
      const s = saf.seasonFromText(bar.textContent)
      if (s !== null) return s
      for (const el of bar.querySelectorAll('*')) {
        const t = saf.seasonFromText(el.textContent)
        if (t !== null) return t
      }
    }
    return null
  }

  let floatEl = null
  function floatBox () {
    if (!floatEl || !floatEl.isConnected) {
      floatEl = document.createElement('div')
      floatEl.className = 'oi-float'
      floatEl.setAttribute(MARK, 'yedek')
      document.body.appendChild(floatEl)
    }
    return floatEl
  }
  function dropFloat () { if (floatEl) { floatEl.remove(); floatEl = null } }

  let detailSince = 0
  let detailKey = ''
  function decorateDetail (route) {
    const key = route.type + '/' + route.id
    if (key !== detailKey) { detailKey = key; detailSince = Date.now(); dropFloat() }
    // Başka bir içerik için kalmış ya da gizli (önceki) sayfada kalmış düğmeleri kaldır.
    for (const el of document.querySelectorAll('[data-oi-for]')) if (el.getAttribute('data-oi-for') !== key || !visible(el)) el.remove()

    const actions = visibleByClass('action-buttons-container')
    const late = Date.now() - detailSince > 8000
    const useFloat = !actions && late
    if (!actions && !late) return
    if (useFloat) warnOnce('detay', 'film/dizi sayfasında düğme yeri (action-buttons-container) bulunamadı')

    // "İndir" / "Sezonu indir"
    if (!document.querySelector(`[${MARK}="indir"][data-oi-for="${key}"]`)) {
      const b = makeBtn('indir', route.type === 'movie' ? '⬇ İndir' : '⬇ Sezonu indir', '', () => {
        const r = saf.parseRoute(location.hash)
        if (r.name !== 'detail') return
        if (r.type === 'series') r.season = currentSeason(r)
        openCenter(r)
      })
      b.title = route.type === 'movie' ? 'Sürüm seç ve cihaza indir (Offline İndir)' : 'Sezonu ya da bölümleri cihaza indir (Offline İndir)'
      b.setAttribute('data-oi-for', key)
      if (useFloat) floatBox().appendChild(b)
      else {
        const wrap = document.createElement('div')
        wrap.className = 'oi-dl-wrap'
        wrap.setAttribute('data-oi-for', key)
        wrap.appendChild(b)
        actions.appendChild(wrap)
      }
    }

    // "Offline oynat" (yalnızca inmiş film)
    const e = route.type === 'movie' ? index.get(route.id) : null
    const playable = e && e.done > 0 && e.play
    const existing = document.querySelector(`[${MARK}="oynat"]`)
    if (!playable) { if (existing) (existing.closest('.oi-actions') || existing).remove(); return }
    if (existing) return
    const info = visibleByClass('meta-info-container')
    if (!info && !late) return
    const pb = makeBtn('oynat', '▶ Offline oynat', 'oi-play', () => {
      const cur = index.get(route.id)
      if (cur && cur.play) playLocal(cur.play)
    })
    pb.title = 'İnmiş dosyayı internetsiz oynat'
    if (info && !useFloat) {
      const bar = document.createElement('div')
      bar.className = 'oi-actions'
      bar.setAttribute('data-oi-for', key)
      pb.setAttribute('data-oi-for', key)
      bar.appendChild(pb)
      info.insertBefore(bar, info.firstChild)
    } else {
      if (!info && late) warnOnce('ust', 'film sayfasının üst bölümü (meta-info-container) bulunamadı')
      pb.setAttribute('data-oi-for', key)
      floatBox().insertBefore(pb, floatBox().firstChild)
    }
  }

  // ---- poster rozetleri
  let boardSince = 0
  let lastRouteName = ''
  function decorateCards (route) {
    let cards = 0
    for (const a of document.querySelectorAll('a[href^="#/detail/"]')) {
      const img = a.querySelector('img')
      if (!img) continue
      cards++
      const r = saf.parseRoute(a.getAttribute('href'))
      const info = r.name === 'detail' ? saf.badgeInfo(index.get(r.id)) : null
      let badge = a.querySelector('.oi-badge')
      if (!info) { if (badge) badge.remove(); continue }
      const host = img.parentElement
      if (!badge) {
        badge = document.createElement('div')
        badge.setAttribute(MARK, 'rozet')
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
        host.appendChild(badge)
      }
      const cls = 'oi-badge oi-' + info.kind
      if (badge.className !== cls) badge.className = cls
      if (badge.textContent !== info.text) badge.textContent = info.text
    }
    // Ana ekran / keşif / kütüphane: çok görsel var ama hiç kart bağlantısı yoksa yapı değişmiştir.
    if (['board', 'discover', 'library'].includes(route.name) && Date.now() - boardSince > 10000 && !cards) {
      const content = document.querySelectorAll('img').length
      if (content >= 6) warnOnce('kart', 'poster kartları (#/detail/ bağlantıları) bulunamadı, rozetler gösterilemiyor')
    }
  }

  // ---- tarama
  function scan () {
    for (const m of document.querySelectorAll('[class*="context-menu-content-"]')) addStreamItem(m)
    for (const m of document.querySelectorAll('[role="menu"]')) addCardItem(m)
    const route = saf.parseRoute(location.hash)
    if (route.name !== lastRouteName) { lastRouteName = route.name; boardSince = Date.now() }
    if (route.name === 'player') { dropFloat(); return }
    if (route.name === 'detail') decorateDetail(route)
    else { detailKey = ''; dropFloat() }
    decorateCards(route)
  }
  let scheduled = false
  function schedule () {
    if (scheduled) return
    scheduled = true
    setTimeout(() => { scheduled = false; try { scan() } catch (e) { console.warn('[Offline İndir] tarama hatası:', e) } }, 120)
  }

  // Tanılama: CDP ya da konsoldan durum okumak için.
  window.__offlineIndirDurum = () => ({
    route: saf.parseRoute(location.hash), warnings: [...warnings.entries()], indexed: index.size,
    overlay: !!overlay, buttons: [...document.querySelectorAll(`[${MARK}]`)].map(el => el.getAttribute(MARK))
  })

  function start () {
    addStyle()
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
    window.addEventListener('hashchange', () => {
      if (overlay && saf.parseRoute(location.hash).name === 'player') closeCenter()
      schedule()
    })
    setInterval(schedule, 2000) // gecikmeli yapı denetimleri (8–10 sn) için
    refresh()
    scan()
  }
  if (document.documentElement && document.body && document.head) start()
  else document.addEventListener('DOMContentLoaded', start)
})()
