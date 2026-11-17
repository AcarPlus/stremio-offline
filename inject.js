// Stremio arayüzüne (web.stremio.com) yerleştirilir. Servis bunu hata ayıklama kapısı üzerinden
// yükler; __API__ servis adresiyle değiştirilir. Eklediği şeyler:
//  - akış sağ tık menüsüne ve kartların üç nokta menüsüne "Cihaza indir",
//  - film sayfasında "İndir", dizi sayfasında "Sezonu indir" (İndirme Merkezi gömülü pencerede),
//  - inmiş/inmekte olan içeriklerin posterinde rozet,
//  - inmiş filmin sayfasının en üstünde "Offline oynat"; film sayfasındaki "İndir" düğmesi içerik
//    inerken/inmişken durumu gösterir ("İniyor %x" / "İndirildi"),
//  - Stremio'nun yan gezinme çubuğunda (Board/Discover/Library) kalıcı "İndirilenler" girişi,
//  - İndirme Merkezi'nden gelen "oynat" iletisiyle yerel dosyayı Stremio oynatıcısında açma.
// Stremio'nun sınıf adlarındaki rastgele eklere (ör. "action-buttons-container-XbKVa") bağlı
// kalınmaz: sınıfın anlamlı kökü aranır (classHas). Beklenen bir yer bulunamazsa düğmeler yedek
// konuma konur ve konsolda + ekranın sol altında küçük bir uyarı gösterilir.
// Saf kısım (saf) Node'da da çalışır: test/inject.test.mjs.
// Servis her yüklemede __SURUM__ damgasını koyar; sayfada farklı sürümden eski bir kopya varsa
// önce o sökülür (servis yeniden başlayınca sayfa yenilemeye gerek kalmaz).
(() => {
  const API = '__API__'
  const SURUM = '__SURUM__'

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
      if (route && route.name === 'indirilenler') return base + 'indirilenler'
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
        if (!e) map.set(imdbId, e = { imdbId, type: type || null, done: 0, active: 0, partial: 0, doneBytes: 0, sizeBytes: 0, play: null })
        if (!e.type && type) e.type = type
        return e
      }
      for (const it of items || []) {
        if (!it) continue
        const activeState = it.state === 'downloading' || it.state === 'resolving'
        const partialState = it.state === 'paused' || it.state === 'error' // kısmen inmiş / yarım kalmış (E7)
        const files = (it.files || []).filter(f => f && f.selected)
        if (!files.length) {
          if ((activeState || partialState) && /^tt\d+$/.test(it.imdbId || '')) entry(it.imdbId, it.type)[activeState ? 'active' : 'partial']++
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
          } else if (partialState) e.partial++
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

    /** Film sayfasındaki "İndir" düğmesinin durumu: { state: 'none' | 'active' | 'partial' | 'done', text, title }. */
    function downloadButton (e, type) {
      if (type !== 'movie') return { state: 'none', text: '⬇ Sezonu indir', title: 'Sezonu ya da bölümleri cihaza indir (Offline İndir)' }
      const b = badgeInfo(e)
      if (b && b.kind === 'done') return { state: 'done', text: '✓ İndirildi', title: 'Cihaza indirildi; İndirilenler’i aç (Offline İndir)' }
      if (b && b.kind === 'active') return { state: 'active', text: b.text, title: 'Cihaza iniyor; İndirilenler’i aç (Offline İndir)' }
      if (e && e.partial > 0) return { state: 'partial', text: '⏸ Yarım kaldı', title: 'İndirme duraklatılmış ya da yarım kalmış; İndirilenler’i aç ve sürdür (Offline İndir)' }
      return { state: 'none', text: '⬇ İndir', title: 'Sürüm seç ve cihaza indir (Offline İndir)' }
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

    return { classHas, parseRoute, seasonFromText, embedUrl, offlineIndex, badgeInfo, streamFor, encodeStream, decodeStream, playerHash, isHostMessage, downloadButton }
  })()

  if (typeof window === 'undefined' || typeof document === 'undefined') { globalThis.__offlineIndirSaf = saf; return }
  if (location.origin !== 'https://web.stremio.com') return
  // Eski (sürüm damgasız) kopya sökülemez; sayfa yenilenene dek o çalışır.
  if (window.__offlineIndir === true) return
  if (window.__offlineIndir) {
    if (window.__offlineIndir.surum === SURUM) return
    try { window.__offlineIndir.stop() } catch (e) { console.warn('[Offline İndir] eski kopya sökülemedi:', e) }
  }
  let stopped = false
  const disposers = []
  /** Dinleyici ekler ve söküm listesine yazar. */
  function on (target, type, fn, opts) {
    target.addEventListener(type, fn, opts)
    disposers.push(() => target.removeEventListener(type, fn, opts))
  }
  window.__offlineIndir = {
    surum: SURUM,
    stop () {
      stopped = true
      for (const d of disposers.splice(0).reverse()) { try { d() } catch {} }
      clearTimeout(pollTimer)
      if (overlay) { clearTimeout(overlay.timer); overlay = null }
      for (const el of document.querySelectorAll(`[${MARK}], #offline-indir-stil, .oi-badge, .oi-actions, .oi-dl-wrap`)) el.remove()
      for (const el of [toastEl, warnEl, floatEl]) if (el) el.remove()
      delete window.__offlineIndirDurum
    }
  }

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
.oi-btn.oi-done{background:#3a2f7a}
.oi-navfloat{position:fixed;left:5.5rem;top:1.2rem;z-index:2147483000;height:3rem;padding:0 1.3rem;font-size:1rem}
.oi-nav{cursor:pointer}
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

  // Stremio menüleri (Radix) dışarı tıklamayı `pointerdown` ile, Esc'yi odaktaki öğeden yükselen
  // `keydown` ile algılar; yalnızca fare olayları menüyü kapatmaz (D1). Üçüncü güvence: menü hâlâ
  // açıksa tetikleyici düğmeye `pointerdown` yollanır (Radix tetikleyicisi açık menüyü kapatır).
  function pointerEvt (type, extra) {
    const init = { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, isPrimary: true, ...extra }
    try { return new PointerEvent(type, init) } catch { return new MouseEvent(type, init) }
  }
  function closeMenus () {
    const trigger = document.querySelector('button[aria-haspopup="menu"][aria-expanded="true"]')
    const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body
    document.body.dispatchEvent(pointerEvt('pointerdown'))
    for (const type of ['mousedown', 'pointerup', 'mouseup', 'click']) {
      document.body.dispatchEvent(type === 'pointerup' ? pointerEvt(type) : new MouseEvent(type, { bubbles: true, cancelable: true }))
    }
    for (const type of ['keydown', 'keyup']) {
      active.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }))
    }
    if (trigger) {
      setTimeout(() => {
        if (!stopped && trigger.isConnected && trigger.getAttribute('aria-expanded') === 'true') {
          trigger.dispatchEvent(pointerEvt('pointerdown', { ctrlKey: false }))
        }
      }, 250)
    }
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
  on(document, 'contextmenu', e => {
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
    if (stopped) return
    try {
      if (saf.parseRoute(location.hash).name !== 'player') {
        const r = await fetch(API + '/api/items', { cache: 'no-store' })
        if (r.ok) { index = saf.offlineIndex((await r.json()).items); schedule() }
      }
    } catch { /* servis kapalı: son bilinen durum kalır */ }
    if (stopped) return
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
  on(document, 'keydown', e => {
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

  on(window, 'message', e => {
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
        // İçerik iniyor ya da inmişse sürüm seçici yerine İndirilenler açılır (D2).
        if (saf.downloadButton(index.get(r.id), r.type).state !== 'none') { openCenter({ name: 'indirilenler' }); return }
        if (r.type === 'series') r.season = currentSeason(r)
        openCenter(r)
      })
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

    // Düğme metni içeriğin durumunu yansıtır (D2): "İniyor %x" / "İndirildi".
    const dl = document.querySelector(`[${MARK}="indir"][data-oi-for="${key}"]`)
    if (dl) {
      const st = saf.downloadButton(index.get(route.id), route.type)
      if (dl.textContent !== st.text) dl.textContent = st.text
      if (dl.title !== st.title) dl.title = st.title
      dl.classList.toggle('oi-done', st.state === 'done')
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

  // ---- yan gezinme çubuğunda kalıcı "İndirilenler" girişi
  const NAV_ICON = '<path d="M256 64v250m0 0L160 218m96 96 96-96M96 400h320" fill="none" stroke="currentColor" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>'
  const NAV_ROUTES = new Set(['board', 'discover', 'library', 'calendar', 'addons', 'settings'])
  let navSince = 0
  let navFloat = null
  function dropNavFloat () { if (navFloat) { navFloat.remove(); navFloat = null } }
  function openDownloads () { openCenter({ name: 'indirilenler' }) }
  function makeNavEntry (sample) {
    const a = sample.cloneNode(true)
    a.className = String(sample.getAttribute('class') || '').split(/\s+/).filter(c => c && c !== 'selected' && c !== 'active').join(' ') + ' oi-nav'
    a.removeAttribute('href')
    a.setAttribute('role', 'button')
    a.setAttribute('tabindex', '0')
    a.title = 'İndirilenler'
    a.setAttribute(MARK, 'nav')
    const label = a.querySelector('div') || a.querySelector('span')
    if (label) label.textContent = 'İndirilenler'
    const svg = a.querySelector('svg')
    if (svg) { svg.setAttribute('viewBox', '0 0 512 512'); svg.innerHTML = NAV_ICON }
    shield(a)
    a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openDownloads() })
    a.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openDownloads() } })
    return a
  }
  function decorateNav (route) {
    // Gezinme çubuğundaki sekme bağlantıları, üst öğelerine (nav) göre gruplanır. Çubuk sınıfının
    // adına değil sekme düğmesinin sınıf köküne (nav-tab-button-container) güvenilir.
    const groups = new Map()
    for (const a of byClass('nav-tab-button-container')) {
      if (a.hasAttribute(MARK)) continue
      const p = a.parentElement
      if (p) { if (!groups.has(p)) groups.set(p, []); groups.get(p).push(a) }
    }
    let shown = 0
    for (const [p, tabs] of groups) {
      const mine = p.querySelector(`[${MARK}="nav"]`)
      if (!visible(p)) { if (mine) mine.remove(); continue }
      shown++
      if (mine) continue
      const lib = tabs.find(a => /#\/library/.test(a.getAttribute('href') || ''))
      const entry = makeNavEntry(lib || tabs[tabs.length - 1])
      const anchor = lib || tabs[Math.min(2, tabs.length - 1)]
      anchor.after(entry)
    }
    // Yinelenenleri ve gizli çubuklarda kalanları temizle.
    for (const el of document.querySelectorAll(`[${MARK}="nav"]`)) if (!visible(el)) el.remove()
    if (shown) { dropNavFloat(); return }
    // Çubuk yok. Çubuğu olması gereken sayfada (ana ekran, keşif, kütüphane…) kısa süre bekle, hâlâ
    // yoksa yapı değişmiştir: uyar. Film/dizi sayfası gibi çubuğu hiç olmayan sayfalarda uyarı yok,
    // doğrudan köşede sabit düğme gösterilir.
    if (NAV_ROUTES.has(route.name)) {
      if (Date.now() - navSince < 8000) return
      warnOnce('nav', 'gezinme çubuğu (nav-tab-button-container) bulunamadı, "İndirilenler" köşede sabit düğme olarak gösteriliyor')
    }
    if (!navFloat || !navFloat.isConnected) {
      navFloat = makeBtn('nav-yedek', '⬇ İndirilenler', 'oi-navfloat', openDownloads)
      document.body.appendChild(navFloat)
    }
  }

  // ---- tarama
  function scan () {
    for (const m of document.querySelectorAll('[class*="context-menu-content-"]')) addStreamItem(m)
    for (const m of document.querySelectorAll('[role="menu"]')) addCardItem(m)
    const route = saf.parseRoute(location.hash)
    if (route.name !== lastRouteName) { lastRouteName = route.name; boardSince = Date.now(); navSince = Date.now() }
    if (route.name === 'player') {
      // Oynatıcıda hiçbir düğme olmaz.
      dropFloat(); dropNavFloat()
      for (const el of document.querySelectorAll(`[${MARK}="nav"]`)) el.remove()
      return
    }
    decorateNav(route)
    if (route.name === 'detail') decorateDetail(route)
    else { detailKey = ''; dropFloat() }
    decorateCards(route)
  }
  let scheduled = false
  function schedule () {
    if (scheduled) return
    scheduled = true
    setTimeout(() => { scheduled = false; if (stopped) return; try { scan() } catch (e) { console.warn('[Offline İndir] tarama hatası:', e) } }, 120)
  }

  // Tanılama: CDP ya da konsoldan durum okumak için.
  window.__offlineIndirDurum = () => ({
    route: saf.parseRoute(location.hash), warnings: [...warnings.entries()], indexed: index.size,
    overlay: !!overlay, buttons: [...document.querySelectorAll(`[${MARK}]`)].map(el => el.getAttribute(MARK))
  })

  function start () {
    addStyle()
    const mo = new MutationObserver(schedule)
    mo.observe(document.documentElement, { childList: true, subtree: true })
    disposers.push(() => mo.disconnect())
    on(window, 'hashchange', () => {
      if (overlay && saf.parseRoute(location.hash).name === 'player') closeCenter()
      schedule()
    })
    const iv = setInterval(schedule, 2000) // gecikmeli yapı denetimleri (8–10 sn) için
    disposers.push(() => clearInterval(iv))
    refresh()
    scan()
  }
  if (document.documentElement && document.body && document.head) start()
  else on(document, 'DOMContentLoaded', start)
})()
