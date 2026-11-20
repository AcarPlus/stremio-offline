// İndirme Merkezi — tek sayfa, çatı kütüphane yok. Rotalar (#): "/" indirmeler, "/indirilenler" (aynı liste), "/ara/<söz>", "/dizi/<tt>",
// "/surum/<movie|series>/<id>", "/sezon/<tt>/<sezon>". API: docs/api.md. Gömülü kip: ?embed=1
'use strict'

const EMBED = new URLSearchParams(location.search).get('embed') === '1'
const $ = (s, r = document) => r.querySelector(s)
const ana = $('#ana')

// ───────────────────────── yardımcılar ─────────────────────────
function h (tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'text') el.textContent = v
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)))
  return el
}
const p2 = n => String(n).padStart(2, '0')
const epCode = (s, e) => `S${p2(s)}E${p2(e)}`

function fmtBytes (n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TB'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' MB'
  if (n >= 1e3) return Math.round(n / 1e3) + ' KB'
  return Math.round(n) + ' B'
}
const fmtSpeed = n => n > 0 ? (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB/sn' : Math.round(n / 1e3) + ' KB/sn') : '0 KB/sn'
function fmtEta (s) {
  if (s == null || !isFinite(s)) return '—'
  s = Math.round(s)
  if (s >= 86400) return Math.floor(s / 86400) + ' gün ' + Math.floor(s % 86400 / 3600) + ' sa'
  if (s >= 3600) return Math.floor(s / 3600) + ' sa ' + Math.floor(s % 3600 / 60) + ' dk'
  if (s >= 60) return Math.floor(s / 60) + ' dk ' + (s % 60) + ' sn'
  return s + ' sn'
}

// ───────────────────────── hız sınırı seçici ─────────────────────────
// Değerler bayt/sn; 0 = sınırsız. Hazır seçenekler + "Elle gir…" (MB/sn ya da KB/sn).
const MB = 1e6
const DL_PRESETS = [[0, 'Sınırsız'], [1 * MB, '1 MB/sn'], [2 * MB, '2 MB/sn'], [5 * MB, '5 MB/sn'], [10 * MB, '10 MB/sn']]
const TH_PRESETS = [[0, 'Kısma yok'], [100e3, '100 KB/sn'], [200e3, '200 KB/sn'], [500e3, '500 KB/sn'], [1 * MB, '1 MB/sn']]
const UL_PRESETS = [[0, 'Sınırsız'], [50e3, '50 KB/sn'], [100e3, '100 KB/sn'], [250e3, '250 KB/sn'], [500e3, '500 KB/sn'], [1 * MB, '1 MB/sn']]
const fmtLimit = n => (n > 0 ? fmtSpeed(n) : 'Sınırsız')
function limitPicker ({ presets, unit = 'MB', label, onSet, okText }) {
  const mult = unit === 'MB' ? MB : 1e3
  const sel = h('select', { 'aria-label': label, title: label })
  // Metin kutusu (inputmode=decimal): "0,5" gibi virgüllü değer de kabul edilir
  const inp = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'sinirSayi', hidden: true, placeholder: '0 = sınırsız', 'aria-label': label + ' (' + unit + '/sn, 0 = sınırsız)' })
  const birim = h('span', { class: 'soluk', hidden: true }, unit + '/sn')
  const ok = h('button', { type: 'button', class: 'dugme kucuk gri', hidden: true }, 'Uygula')
  let current = null
  let busy = false
  function fill (v) {
    const known = presets.some(([n]) => n === v)
    sel.replaceChildren(...presets.map(([n, t]) => h('option', { value: String(n) }, t)),
      known || v == null ? null : h('option', { value: String(v) }, fmtLimit(v)),
      h('option', { value: 'ozel' }, 'Elle gir…'))
    if (v != null) sel.value = String(v)
  }
  const custom = () => !inp.hidden
  const showCustom = on => { inp.hidden = birim.hidden = ok.hidden = !on }
  async function apply (v) {
    busy = true; sel.disabled = true
    try { await onSet(v); current = v; fill(v); if (okText) toast(okText(v), 'ok') } catch (e) { toast(e.message, 'hata'); fill(current) } finally { busy = false; sel.disabled = false }
  }
  sel.addEventListener('change', () => {
    if (sel.value === 'ozel') { showCustom(true); inp.value = current > 0 ? String(+(current / mult).toFixed(2)).replace('.', ',') : ''; inp.focus(); inp.select(); return }
    showCustom(false); apply(Number(sel.value))
  })
  const fromInput = () => {
    const t = String(inp.value).trim().replace(',', '.')
    const x = /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN
    if (!(x >= 0)) { toast('Geçerli bir sayı yaz (0 = sınırsız).', 'hata'); inp.focus(); return }
    const v = Math.round(x * mult)
    // Sunucu katıdır: 0 (sınırsız) ya da 1000..4294967295 bayt/sn. Çok küçük pozitif değer sessizce 0'a (sınırsız) yuvarlanmaz.
    if (v !== 0 && (v < 1000 || v > 4294967295)) { toast('Hız sınırı en az 1 KB/sn ve en çok 4000 MB/sn olabilir (0 = sınırsız).', 'hata'); inp.focus(); return }
    showCustom(false); apply(v)
  }
  ok.addEventListener('click', fromInput)
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); fromInput() }
    if (e.key === 'Escape') { e.stopPropagation(); showCustom(false); fill(current) }
  })
  fill(null)
  return {
    el: h('span', { class: 'sinirSecici' }, sel, inp, birim, ok),
    /** Sunucudan gelen değer (kullanıcı seçerken ya da elle girerken dokunulmaz) */
    set (v) { if (v === current || busy || custom() || document.activeElement === sel) return; current = v; fill(v) },
    get value () { return current }
  }
}

async function api (path, opts) {
  let r
  try { r = await fetch(path, opts) } catch { throw new Error('Servise ulaşılamıyor. İndirme servisi çalışıyor mu?') }
  let j = null
  try { j = await r.json() } catch {}
  if (!r.ok) throw new Error((j && j.err) || `Sunucu hatası (${r.status})`)
  return j
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })

function toast (metin, tur = '') {
  const el = h('div', { class: 'bildirim ' + tur, role: tur === 'hata' ? 'alert' : 'status' }, metin)
  $('#bildirimler').append(el)
  setTimeout(() => el.remove(), tur === 'hata' ? 7000 : 4000)
}

function onayla ({ baslik, metin, tamam = 'Tamam', tik = null }) {
  const d = $('#onay')
  $('#onayBaslik').textContent = baslik
  $('#onayMetin').textContent = metin
  $('#onayTamam').textContent = tamam
  $('#onayTikSatiri').hidden = !tik
  $('#onayTik').checked = false
  if (tik) $('#onayTikMetin').textContent = tik
  return new Promise(resolve => {
    d.addEventListener('close', () => resolve({ ok: d.returnValue === 'tamam', tik: $('#onayTik').checked }), { once: true })
    d.returnValue = ''
    d.showModal()
  })
}

const { qualityGroup, qualityRank: QUALITY_RANK, qualityLabel, compareQuality, errorText, deleteText, pickOption, qualityGroups } = OfflineYardimci // web/yardimci.js
const LANG = { gb: 'İngilizce', us: 'İngilizce', tr: 'Türkçe', ru: 'Rusça', ua: 'Ukraynaca', fr: 'Fransızca', de: 'Almanca', es: 'İspanyolca', mx: 'İspanyolca', it: 'İtalyanca', pt: 'Portekizce', br: 'Portekizce', jp: 'Japonca', kr: 'Korece', cn: 'Çince', pl: 'Lehçe', nl: 'Felemenkçe', se: 'İsveççe', gr: 'Yunanca', in: 'Hintçe', sa: 'Arapça', cz: 'Çekçe', hu: 'Macarca', ro: 'Romence', th: 'Tayca' }
const langName = c => LANG[c] || c.toUpperCase()
const STATE_TR = { resolving: 'Bilgi alınıyor', downloading: 'İniyor', paused: 'Duraklatıldı', completed: 'Hazır', error: 'Hata' }

// ───────────────────────── gömülü kip ─────────────────────────
const HOST_ORIGIN = (() => { try { return location.ancestorOrigins && location.ancestorOrigins[0] ? location.ancestorOrigins[0] : '*' } catch { return '*' } })()
function sendHost (msg) {
  try { window.parent.postMessage({ source: 'offline-indir', ...msg }, HOST_ORIGIN) } catch {}
}
function absUrl (u) { try { return new URL(u, location.origin).href } catch { return u } }

/** Oynat: gömülü kipte üst pencereye bildirir, değilse oynatma adresini açar. */
function playDescriptor (it, f) {
  const file = f || (it.files || []).find(x => x.selected) || {}
  return {
    id: it.id, infoHash: it.infoHash, type: it.type, imdbId: it.imdbId, videoId: file.videoId || it.imdbId || null,
    season: file.season ?? null, episode: file.episode ?? null, fileIdx: file.idx ?? null, fileName: file.name || it.name,
    title: it.displayName || it.name, name: it.name, state: it.state, poster: it.poster || '', playUrl: absUrl(file.playUrl || it.playUrl)
  }
}
function oynat (desc, tab) {
  if (!desc.playUrl) { toast('Bu içeriğin oynatma adresi henüz hazır değil.', 'hata'); return }
  if (EMBED) { sendHost({ type: 'oynat', item: desc }); return }
  if (tab && !tab.closed) tab.location.href = desc.playUrl
  else window.open(desc.playUrl, '_blank', 'noopener')
}
if (EMBED) {
  document.documentElement.classList.add('gomulu')
  $('#kapatDugmesi').hidden = false
  $('#kapatDugmesi').addEventListener('click', () => sendHost({ type: 'kapat' }))
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#onay').open) sendHost({ type: 'kapat' }) })
}

// ───────────────────────── yönlendirici ─────────────────────────
let cleanup = null
const routes = []
const route = (re, fn, nav) => routes.push({ re, fn, nav })

async function render () {
  if (cleanup) { try { cleanup() } catch {} cleanup = null }
  const path = location.hash.replace(/^#/, '') || '/'
  let hit = null
  for (const r of routes) { const m = r.re.exec(path); if (m) { hit = { r, m }; break } }
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('aktif', !!hit && a.dataset.nav === hit.r.nav))
  const token = Symbol(); render.token = token
  ana.replaceChildren()
  window.scrollTo(0, 0)
  if (!hit) { ana.append(h('p', { class: 'soluk' }, 'Sayfa bulunamadı. ', h('a', { href: '#/' }, 'İndirmelere dön'))); return }
  const c = await hit.r.fn(ana, ...hit.m.slice(1).map(s => { try { return decodeURIComponent(s) } catch { return s } }), () => render.token === token)
  if (render.token === token) cleanup = c || null
  else if (c) c()
}
addEventListener('hashchange', render)

$('#aramaFormu').addEventListener('submit', e => {
  e.preventDefault()
  const q = $('#aramaKutusu').value.trim()
  if (q.length >= 2) location.hash = '#/ara/' + encodeURIComponent(q)
  else toast('Aramak için en az 2 harf yaz.')
})

const yukleniyor = metin => h('div', { class: 'yukleniyor' }, h('div', { class: 'donen' }), h('span', null, metin))
function hataKutusu (mesaj, yeniden) {
  return h('div', { class: 'hatakutu', role: 'alert' }, h('span', null, mesaj), yeniden ? h('button', { class: 'dugme gri kucuk', onclick: yeniden }, 'Yeniden dene') : null)
}

// ───────────────────────── 1) İndirmeler ─────────────────────────
const RANK = { resolving: 0, downloading: 0, paused: 1, error: 1, completed: 2 }
const FILTERS = [['hepsi', 'Tümü'], ['devam', 'Devam edenler'], ['biten', 'Bitenler']]

function episodeLabel (it) {
  const sel = (it.files || []).filter(f => f.selected)
  const eps = sel.filter(f => f.season != null && f.episode != null)
  if (!eps.length) return sel.length > 1 ? sel.length + ' dosya' : ''
  if (eps.length === 1 && sel.length === 1) return epCode(eps[0].season, eps[0].episode)
  const seasons = [...new Set(eps.map(f => f.season))].sort((a, b) => a - b)
  return (seasons.length === 1 ? 'S' + p2(seasons[0]) + ' · ' : seasons.length + ' sezon · ') + eps.length + ' bölüm'
}
function sortedFiles (it) {
  return (it.files || []).filter(f => f.selected).sort((a, b) => (a.season ?? 1e3) - (b.season ?? 1e3) || (a.episode ?? 1e3) - (b.episode ?? 1e3) || a.idx - b.idx)
}
function mainFile (it) {
  const fs = sortedFiles(it)
  return fs.find(f => f.complete) || fs[0] || null
}

function viewHome (root, current, baslik = 'İndirmeler') {
  const strip = {
    disk: h('b', null, '—'), bos: h('b', null, '—'), hiz: h('b', null, '—'), aktif: h('b', null, '—')
  }
  const motorUyari = h('div', { class: 'uyari', hidden: true }, 'İndirme motoru şu an hazır değil; birkaç saniye içinde yeniden denenecek.')
  const baglanti = h('div', { class: 'hatakutu', hidden: true, role: 'alert' }, 'İndirme servisine ulaşılamıyor. Servis çalışıyor mu? Bağlantı gelince bu sayfa kendiliğinden yenilenir.')
  const list = h('div', { class: 'liste' })
  const bos = h('div', { class: 'bos-liste', hidden: true })
  const chips = FILTERS.map(([k, ad]) => h('button', { type: 'button', class: 'cip', 'aria-pressed': k === 'hepsi' ? 'true' : 'false', 'data-f': k }, ad, ' ', h('span', { class: 'sayi' })))
  let filter = 'hepsi'
  const cards = new Map()
  let items = []

  // Hız sınırları: yeni indirmeler için varsayılan (+ hepsine uygula) ve yükleme sınırı (bütün indirmeler)
  const varsayilan = limitPicker({
    presets: DL_PRESETS, label: 'Yeni indirmeler için hız sınırı',
    onSet: v => post('/api/settings', { defaultDownloadLimit: v }),
    okText: v => 'Yeni indirmeler için hız sınırı: ' + fmtLimit(v)
  })
  const yukleme = limitPicker({
    presets: UL_PRESETS, unit: 'KB', label: 'Yükleme sınırı',
    onSet: v => post('/api/settings', { uploadLimit: v }),
    okText: v => 'Yükleme sınırı: ' + fmtLimit(v)
  })
  const hepsine = h('button', { type: 'button', class: 'dugme kucuk gri', title: 'Varsayılan sınırı bütün indirmelere uygula' }, 'Hepsine uygula')
  hepsine.addEventListener('click', async () => {
    const r = await onayla({ baslik: 'Hepsine uygulansın mı?', metin: `Her indirmenin hız sınırı ${fmtLimit(varsayilan.value)} olur. Tek tek seçtiğin sınırlar değişir.`, tamam: 'Uygula' })
    if (!r.ok) return
    hepsine.disabled = true
    try { await post('/api/settings', { applyToAll: true }); toast('Bütün indirmelerin hız sınırı: ' + fmtLimit(varsayilan.value), 'ok'); await tick() } catch (e) { toast(e.message, 'hata') } finally { hepsine.disabled = false }
  })
  const kisma = limitPicker({
    presets: TH_PRESETS, unit: 'KB', label: 'Öncelikli indirme varken diğerlerinin hızı',
    onSet: v => post('/api/settings', { priorityThrottle: v }),
    okText: v => v > 0 ? 'Öncelik varken diğer indirmeler: ' + fmtLimit(v) : 'Öncelik diğer indirmeleri kısmaz'
  })
  // İndirme klasörü: yalnız yeni indirmelere uygulanır; süren ve biten indirmeler eski yerinde kalır
  const klasorYol = h('code', { class: 'klasorYol' }, '—')
  const klasorDugme = h('button', { type: 'button', class: 'dugme kucuk gri' }, 'Değiştir')
  const klasorElle = h('button', { type: 'button', class: 'dugme kucuk gri', title: 'Klasör yolunu elle yaz' }, 'Elle yaz')
  const klasorGiris = h('input', { type: 'text', class: 'klasorGiris', autocomplete: 'off', spellcheck: 'false', placeholder: 'D:\\Filmler', 'aria-label': 'İndirme klasörü yolu', hidden: true })
  const klasorUygula = h('button', { type: 'button', class: 'dugme kucuk', hidden: true }, 'Uygula')
  let klasorSimdi = ''
  async function klasorUygulaYol (yol) {
    try {
      const r = await post('/api/settings', { downloadDir: yol })
      klasorSimdi = r.downloadDir; klasorYol.textContent = klasorSimdi; klasorYol.title = klasorSimdi
      klasorGiris.hidden = true; klasorUygula.hidden = true
      toast('Yeni indirmeler şuraya inecek: ' + klasorSimdi + ' (süren ve biten indirmeler eski yerinde kalır)', 'ok')
      await tick()
    } catch (e) { toast(e.message, 'hata') }
  }
  function klasorGirisAc () {
    klasorGiris.hidden = false; klasorUygula.hidden = false
    if (!klasorGiris.value) klasorGiris.value = klasorSimdi
    klasorGiris.focus(); klasorGiris.select()
  }
  klasorElle.addEventListener('click', () => { if (klasorGiris.hidden) klasorGirisAc(); else { klasorGiris.hidden = true; klasorUygula.hidden = true } })
  klasorUygula.addEventListener('click', () => klasorUygulaYol(klasorGiris.value))
  klasorGiris.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); klasorUygulaYol(klasorGiris.value) } })
  klasorDugme.addEventListener('click', async () => {
    klasorDugme.disabled = true
    try {
      const r = await post('/api/klasor-sec')
      if (r.path) await klasorUygulaYol(r.path)
    } catch (e) { toast(e.message + ' — yolu "Elle yaz" ile girebilirsin.', 'hata'); klasorGirisAc() } finally { klasorDugme.disabled = false }
  })
  const klasorAyar = h('div', { class: 'araclar klasorSatiri' },
    h('span', { class: 'sinirEtiket' }, 'İndirme klasörü:'), klasorYol, klasorDugme, klasorElle, klasorGiris, klasorUygula,
    h('span', { class: 'soluk klasorNot' }, 'Yeni indirmeler için; süren ve biten indirmeler eski yerinde kalır.'))

  const sinirAyar = h('div', { class: 'araclar sinirlar' },
    h('span', { class: 'sinirEtiket' }, 'Yeni indirmeler için hız sınırı', varsayilan.el), hepsine,
    h('span', { class: 'sinirEtiket' }, 'Yükleme sınırı', yukleme.el),
    h('span', { class: 'sinirEtiket', title: 'Bir indirme ★ öncelikli yapılınca diğer etkin indirmeler bu hıza kısılır (durmaz)' }, '★ Öncelik varken diğerleri', kisma.el))

  root.append(
    h('h1', null, baslik),
    h('p', { class: 'soluk', style: 'margin:0 0 10px' }, 'Cihazına indirilen filmler ve diziler. Bitenler internetsiz de oynar.'),
    motorUyari, baglanti,
    h('div', { class: 'serit' },
      h('div', null, strip.disk, h('span', null, 'İndirmelerin kapladığı alan')),
      h('div', null, strip.bos, h('span', null, 'Diskte boş alan')),
      h('div', null, strip.hiz, h('span', null, 'Toplam hız')),
      h('div', null, strip.aktif, h('span', null, 'Etkin indirme'))),
    klasorAyar,
    sinirAyar,
    h('div', { class: 'suzgec' }, chips),
    list, bos)

  chips.forEach(c => c.addEventListener('click', () => {
    filter = c.dataset.f
    chips.forEach(x => x.setAttribute('aria-pressed', String(x === c)))
    applyFilter()
  }))

  const visible = it => filter === 'hepsi' || (filter === 'biten' ? it.state === 'completed' : it.state !== 'completed')
  function applyFilter () {
    let n = 0
    for (const it of items) { const c = cards.get(it.id); if (c) { c.el.hidden = !visible(it); if (!c.el.hidden) n++ } }
    bos.hidden = n > 0
    if (!items.length) {
      bos.replaceChildren('Henüz indirme yok.', h('br'), 'Bir film ya da dizi ara, sürümünü seç ve indir.', h('br'), h('a', { class: 'dugme', href: '#/ara' }, 'Başlık ara'))
    } else if (!n) bos.replaceChildren('Bu süzgeçte gösterilecek bir şey yok.')
    chips[0].querySelector('.sayi').textContent = items.length
    chips[1].querySelector('.sayi').textContent = items.filter(i => i.state !== 'completed').length
    chips[2].querySelector('.sayi').textContent = items.filter(i => i.state === 'completed').length
  }

  function setSummary (s) {
    const set = (el, v) => { if (el.textContent !== v) el.textContent = v }
    set(strip.disk, fmtBytes(s.usedBytes))
    set(strip.bos, s.diskFreeBytes != null ? fmtBytes(s.diskFreeBytes) : '—')
    set(strip.hiz, fmtSpeed(s.downloadSpeed))
    set(strip.aktif, String(s.active))
    if (s.downloadDir && s.downloadDir !== klasorSimdi) { klasorSimdi = s.downloadDir; klasorYol.textContent = klasorSimdi; klasorYol.title = klasorSimdi }
    if (s.settings) { varsayilan.set(s.settings.defaultDownloadLimit); yukleme.set(s.settings.uploadLimit); kisma.set(s.settings.priorityThrottle) }
    motorUyari.hidden = !s.engine || s.engine.ready !== false ? true : false
    if (s.engine && s.engine.ready === false && s.engine.error) motorUyari.textContent = 'İndirme motoru hazır değil: ' + s.engine.error
  }

  function sync (list2) {
    items = [...list2].sort((a, b) => (RANK[a.state] ?? 1) - (RANK[b.state] ?? 1) || b.addedAt - a.addedAt)
    const seen = new Set()
    for (const it of items) {
      seen.add(it.id)
      let c = cards.get(it.id)
      if (!c) { c = makeCard(it); cards.set(it.id, c) }
      c.update(it)
    }
    for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id) }
    items.forEach((it, i) => { const el = cards.get(it.id).el; if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null) })
    applyFilter()
  }

  async function act (it, what, btn) {
    try {
      if (what === 'oynat') { const f = mainFile(it); oynat(playDescriptor(it, f)); return }
      if (what === 'iptal' || what === 'sil') {
        const ad = it.displayName || it.name
        const r = what === 'iptal'
          ? await onayla({ baslik: 'İndirme iptal edilsin mi?', metin: `“${ad}” indirmesi durdurulur, şimdiye kadar inen kısım silinir ve kayıt kalkar.`, tamam: 'İptal et' })
          : await onayla({ baslik: 'Silinsin mi?', metin: deleteText(it, fmtBytes), tamam: 'Sil', tik: 'Dosyaları diskte bırak (yalnız kaydı kaldır)' })
        if (!r.ok) return
        btn.disabled = true
        if (what === 'iptal') await post(`/api/items/${it.id}/cancel`)
        else await api(`/api/items/${it.id}${r.tik ? '?keepFiles=1' : ''}`, { method: 'DELETE' })
        toast(what === 'iptal' ? 'İndirme iptal edildi.' : 'Silindi.', 'ok')
      } else if (what === 'oncelik') {
        btn.disabled = true
        const on = !it.priority
        const v = await post(`/api/items/${it.id}/priority`, { priority: on })
        const c = cards.get(it.id); if (c && v) c.update(v)
        toast(on ? '★ Öncelikli: ' + (it.displayName || it.name) : 'Öncelik kaldırıldı.', 'ok')
      } else {
        btn.disabled = true
        const v = await post(`/api/items/${it.id}/${what === 'duraklat' ? 'pause' : 'resume'}`)
        const c = cards.get(it.id); if (c && v) c.update(v)
      }
      await tick()
    } catch (e) { toast(e.message, 'hata') } finally { btn.disabled = false }
  }

  function makeCard (it0) {
    let it = it0
    const last = {}
    const upd = (k, v, fn) => { if (last[k] !== v) { last[k] = v; fn(v) } }
    const afis = h('div', { class: 'afis bos', 'aria-hidden': 'true' }, '🎬')
    const baslik = h('h3', { class: 'baslik' })
    const bolum = h('span', { class: 'bolum' })
    const rozet = h('span', { class: 'rozet' })
    const dosya = h('div', { class: 'dosya' })
    const bar = h('i')
    const cubuk = h('div', { class: 'cubuk', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar)
    const sYuzde = h('span', { class: 'yuzde' }), sHiz = h('span'), sKalan = h('span'), sKaynak = h('span'), sBoyut = h('span'), sKalite = h('span')
    const istat = h('div', { class: 'istat' }, sYuzde, sHiz, sKalan, sKaynak, sBoyut, sKalite)
    const hata = h('div', { class: 'hata', hidden: true })
    const sinir = limitPicker({
      presets: DL_PRESETS, label: 'Bu indirmenin hız sınırı',
      onSet: v => post(`/api/items/${it.id}/limit`, { downloadLimit: v }),
      okText: v => 'Hız sınırı: ' + fmtLimit(v)
    })
    const kisildi = h('span', { class: 'kisildi', hidden: true })
    const sinirSatiri = h('div', { class: 'sinirSatiri' }, h('span', { class: 'soluk' }, 'Hız sınırı'), sinir.el, kisildi)
    const dosyaListe = h('div')
    const det = h('details', { class: 'dosyalar', hidden: true }, h('summary', null, 'Bölümler'), dosyaListe)
    const btn = {
      oynat: h('button', { class: 'dugme oynat', 'data-a': 'oynat' }, '▶ Oynat'),
      duraklat: h('button', { class: 'dugme gri', 'data-a': 'duraklat' }, '⏸ Duraklat'),
      surdur: h('button', { class: 'dugme', 'data-a': 'surdur' }, '▶ Sürdür'),
      oncelik: h('button', { class: 'dugme gri oncelik', 'data-a': 'oncelik', 'aria-pressed': 'false', title: 'Öncelikli yap: bu indirme tam hızda sürer, diğer etkin indirmeler yavaşlar' }, '☆ Öncelik'),
      iptal: h('button', { class: 'dugme hayalet', 'data-a': 'iptal' }, 'İptal'),
      sil: h('button', { class: 'dugme hayalet', 'data-a': 'sil' }, 'Sil')
    }
    const eylem = h('div', { class: 'eylemler' }, Object.values(btn))
    const el = h('article', { class: 'kart' }, afis, h('div', { class: 'govde' }, h('div', { class: 'baslikSatiri' }, baslik, bolum, rozet), dosya, cubuk, istat, sinirSatiri, hata, det), eylem)
    eylem.addEventListener('click', e => { const b = e.target.closest('button[data-a]'); if (b) act(it, b.dataset.a, b) })
    const fileRows = new Map()

    function update (n) {
      it = n
      const done = it.state === 'completed'
      el.classList.toggle('biten', done)
      el.classList.toggle('hatali', it.state === 'error')
      el.classList.toggle('bekle', it.state === 'resolving' || (it.state === 'downloading' && it.engineState === 'initializing'))
      upd('poster', it.poster, p => {
        if (p) { const img = h('img', { class: 'afis', src: p, alt: '', loading: 'lazy' }); img.onerror = () => img.replaceWith(afis); afis.replaceWith(img) }
      })
      upd('baslik', it.displayName || it.name, t => { baslik.textContent = t })
      upd('bolum', episodeLabel(it), t => { bolum.textContent = t; bolum.hidden = !t })
      upd('rozet', it.state, s => { rozet.textContent = STATE_TR[s] || s; rozet.className = 'rozet ' + s })
      const sel = sortedFiles(it)
      upd('dosya', (sel.length === 1 ? sel[0].name : it.name) || '', t => { dosya.textContent = t; dosya.title = t })
      const pct = Math.floor(it.percent * 10) / 10
      upd('pct', done ? 100 : pct, v => { bar.style.width = v + '%'; cubuk.setAttribute('aria-valuenow', String(Math.floor(v))) })
      const active = it.state === 'downloading'
      upd('yuzde', done ? '✔ Hazır' : (it.state === 'resolving' ? 'Torrent bilgisi alınıyor…' : (it.state === 'error' && !pct ? '' : '%' + pct.toFixed(1))), t => { sYuzde.textContent = t; sYuzde.hidden = !t })
      upd('hiz', active ? '↓ ' + fmtSpeed(it.downloadSpeed) : '', t => { sHiz.textContent = t; sHiz.hidden = !t })
      upd('kalan', active ? 'Kalan: ' + fmtEta(it.eta) : '', t => { sKalan.textContent = t; sKalan.hidden = !t })
      upd('kaynak', active ? it.peers + ' kaynak' : '', t => { sKaynak.textContent = t; sKaynak.hidden = !t })
      upd('boyut', done ? fmtBytes(it.sizeBytes) : (it.sizeBytes ? fmtBytes(it.doneBytes) + ' / ' + fmtBytes(it.sizeBytes) : ''), t => { sBoyut.textContent = t; sBoyut.hidden = !t })
      const q = (it.source && it.source.quality) || ''
      upd('kalite', q, t => { sKalite.textContent = t; sKalite.hidden = !t })
      upd('hata', it.state === 'error' ? it.error || 'Bilinmeyen bir sorun oluştu.' : '', t => {
        hata.hidden = !t
        hata.textContent = t ? errorText(t) : ''
      })
      sinirSatiri.hidden = done // bitmiş indirmenin süreci yok, sınır anlamsız
      sinir.set(it.downloadLimit ?? 0)
      upd('kisildi', it.playing ? 'Oynatılıyor: sınır askıda' : (it.throttled ? 'Öncelik nedeniyle kısıldı: ' + fmtLimit(it.effectiveLimit) : (it.priorityIdle ? 'Öncelikli, ama veri almıyor: diğerleri kısılmıyor' : '')), t => { kisildi.textContent = t; kisildi.hidden = !t })
      btn.oncelik.hidden = done
      upd('oncelik', (it.priority ? 1 : 0) + ':' + (it.state === 'paused' ? 'd' : ''), k => {
        const on = k[0] === '1'; const dur = k.endsWith('d')
        btn.oncelik.setAttribute('aria-pressed', String(on))
        btn.oncelik.textContent = on ? '★ Öncelikli' : '☆ Öncelik'
        btn.oncelik.title = (on ? 'Önceliği kaldır: diğer indirmeler kendi sınırlarına döner' : 'Öncelikli yap: bu indirme tam hızda sürer, diğer etkin indirmeler yavaşlar') +
          (dur ? ' (duraklatılmış: etkisi indirme sürdürülünce başlar)' : '')
      })
      el.classList.toggle('oncelikli', !!it.priority && !done)
      btn.oynat.hidden = !(done || it.state === 'downloading')
      btn.oynat.classList.toggle('gri', !done); btn.oynat.classList.toggle('oynat', done)
      btn.duraklat.hidden = !(it.state === 'downloading' || it.state === 'resolving')
      btn.surdur.hidden = !(it.state === 'paused' || it.state === 'error')
      btn.iptal.hidden = done
      btn.sil.hidden = !done
      // çok dosyalı öğe: bölüm listesi (yerinde güncellenir)
      det.hidden = sel.length < 2
      if (sel.length >= 2) {
        det.firstChild.textContent = sel.length + ' dosya'
        const seen = new Set()
        sel.forEach((f, i) => {
          seen.add(f.idx)
          let r = fileRows.get(f.idx)
          if (!r) {
            const ad = h('span', { class: 'ad' }), yz = h('span', { class: 'yz' })
            const b = h('button', { class: 'dugme kucuk gri' }, '▶')
            b.addEventListener('click', () => { const ff = (it.files || []).find(x => x.idx === f.idx); oynat(playDescriptor(it, ff)) })
            r = { el: h('div', { class: 'dosyaSatiri' }, ad, yz, b), ad, yz, b, last: {} }
            fileRows.set(f.idx, r)
          }
          const lab = (f.season != null && f.episode != null ? epCode(f.season, f.episode) + ' · ' : '') + f.name
          if (r.last.ad !== lab) { r.last.ad = lab; r.ad.textContent = lab; r.ad.title = lab }
          const yz = f.complete ? '✔' : '%' + Math.floor(f.progress * 100)
          if (r.last.yz !== yz) { r.last.yz = yz; r.yz.textContent = yz }
          r.b.title = 'Oynat'
          if (dosyaListe.children[i] !== r.el) dosyaListe.insertBefore(r.el, dosyaListe.children[i] || null)
        })
        for (const [idx, r] of fileRows) if (!seen.has(idx)) { r.el.remove(); fileRows.delete(idx) }
      }
    }
    update(it0)
    return { el, update }
  }

  let timer = null; let stopped = false; let busy = false; let fails = 0
  async function tick () {
    if (busy || stopped) return
    busy = true
    try {
      const r = await api('/api/items')
      if (stopped || !current()) return
      fails = 0; baglanti.hidden = true
      setSummary(r.summary); sync(r.items)
    } catch { fails++; if (fails >= 2) baglanti.hidden = false } finally { busy = false }
  }
  const loop = () => { if (stopped) return; tick().finally(() => { timer = setTimeout(loop, document.hidden ? 5000 : 1000) }) }
  loop()
  const onVis = () => { if (!document.hidden) { clearTimeout(timer); loop() } }
  document.addEventListener('visibilitychange', onVis)
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis) }
}
route(/^\/$/, (r, c) => viewHome(r, c), 'indirmeler')
// Stremio gezinme çubuğundaki "İndirilenler" girişi: aynı liste (Tümü süzgeci), başlık farklı.
route(/^\/indirilenler$/, (r, c) => viewHome(r, c, 'İndirilenler'), 'indirmeler')

// ───────────────────────── 2) Arama ─────────────────────────
async function viewAra (root, q, current) {
  if (typeof q === 'function') { current = q; q = '' }
  const kutu = $('#aramaKutusu')
  root.append(h('h1', null, 'Başlık ara'))
  if (!q) {
    root.append(h('p', { class: 'soluk' }, 'Yukarıdaki kutuya film ya da dizi adını yaz. Sonuçtan sürümünü (film) ya da sezonunu (dizi) seçip indirebilirsin.'))
    kutu.focus(); return
  }
  kutu.value = q
  const alan = h('div'); root.append(h('p', { class: 'soluk' }, `“${q}” için sonuçlar`), alan)
  alan.append(yukleniyor('Aranıyor…'))
  const yap = async () => {
    alan.replaceChildren(yukleniyor('Aranıyor…'))
    try {
      const r = await api('/api/search?q=' + encodeURIComponent(q))
      if (!current()) return
      alan.replaceChildren()
      if (!r.results.length) { alan.append(h('div', { class: 'bos-liste' }, 'Sonuç bulunamadı. Başka bir yazımla dene.')); return }
      for (const [tur, ad] of [['movie', 'Filmler'], ['series', 'Diziler']]) {
        const l = r.results.filter(x => x.type === tur)
        if (!l.length) continue
        alan.append(h('h2', null, ad), h('div', { class: 'sonuclar' }, l.map(x =>
          h('a', { class: 'sonuc', href: tur === 'movie' ? `#/surum/movie/${x.id}` : `#/dizi/${x.id}` },
            x.poster ? h('img', { src: x.poster, alt: '', loading: 'lazy', onerror: e => e.target.replaceWith(h('div', { class: 'afis bos' }, '🎬')) }) : h('div', { class: 'afis bos' }, '🎬'),
            h('div', null, h('b', null, x.name), h('span', null, x.year || ' '))))))
      }
    } catch (e) { if (current()) alan.replaceChildren(hataKutusu(e.message, yap)) }
  }
  yap()
}
route(/^\/ara$/, (r, c) => viewAra(r, '', c), 'ara')
route(/^\/ara\/(.+)$/, viewAra, 'ara')

// ───────────────────────── 3) Dizi (sezon listesi) ─────────────────────────
async function viewDizi (root, id, current) {
  root.append(h('a', { class: 'geri', href: '#/ara' }, '← Aramaya dön'), yukleniyor('Dizi bilgisi alınıyor…'))
  try {
    const t = await api(`/api/title?type=series&id=${id}`)
    if (!current()) return
    root.replaceChildren(
      h('a', { class: 'geri', href: '#/ara' }, '← Aramaya dön'),
      baslikBandi(t),
      h('h2', null, 'Sezon seç'),
      t.seasons.length
        ? h('div', { class: 'sezonlar' }, t.seasons.map(s => h('a', { class: 'dugme gri', href: `#/sezon/${id}/${s.season}` }, (s.season === 0 ? 'Özel bölümler' : s.season + '. sezon') + ' · ' + s.episodes + ' bölüm')))
        : h('p', { class: 'soluk' }, 'Bu dizi için sezon bilgisi bulunamadı.'))
  } catch (e) { if (current()) root.replaceChildren(h('a', { class: 'geri', href: '#/ara' }, '← Aramaya dön'), hataKutusu(e.message, () => render())) }
}
route(/^\/dizi\/(tt\d+)$/, viewDizi, 'ara')

function baslikBandi (t, ek) {
  return h('div', { class: 'bant' },
    t && t.poster ? h('img', { class: 'afis', src: t.poster, alt: '', onerror: e => e.target.remove() }) : null,
    h('div', null, h('h1', null, t ? t.name : '', ek ? ' ' : '', ek ? h('span', { class: 'bolum' }, ek) : null),
      t && t.year ? h('span', { class: 'soluk' }, t.year) : null,
      t && t.description ? h('p', null, t.description) : null))
}

// ───────────────────────── 4) Sürüm seçici ─────────────────────────
function libraryLabel (lib) {
  if (!lib) return null
  const map = { resolving: ['Hazırlanıyor', 'bekle'], downloading: ['İniyor', 'iniyor'], paused: ['Duraklatıldı', 'bekle'], completed: ['İndirildi', ''], error: ['Hata — indirmelerde', 'bekle'] }
  return map[lib.state] || [lib.state, '']
}

async function viewSurum (root, type, id, current) {
  const imdb = id.split(':')[0]
  const m = /^tt\d+:(\d+):(\d+)$/.exec(id)
  const ep = m ? epCode(+m[1], +m[2]) : ''
  const geri = type === 'series' && m ? h('a', { class: 'geri', href: `#/sezon/${imdb}/${+m[1]}` }, '← Sezon seçiciye dön') : h('a', { class: 'geri', href: '#/ara' }, '← Aramaya dön')
  const bant = h('div'); bant.append(baslikBandi(null, ep))
  const govde = h('div')
  root.append(geri, bant, govde, yukleniyor('Sürümler Torrentio’dan getiriliyor…'))
  api(`/api/title?type=${type}&id=${imdb}`).then(t => { if (current()) bant.replaceChildren(baslikBandi(t, ep)) }).catch(() => {})

  let data
  const yukle = async () => {
    root.lastChild.replaceWith(yukleniyor('Sürümler Torrentio’dan getiriliyor…'))
    try { data = await api(`/api/versions?type=${type}&id=${encodeURIComponent(id)}`) } catch (e) {
      if (current()) root.lastChild.replaceWith(hataKutusu('Sürümler alınamadı: ' + e.message, yukle)); return
    }
    if (!current()) return
    root.lastChild.remove()
    kur()
  }
  yukle()

  function kur () {
    const vs = data.versions
    const st = { key: 'seeders', dir: -1, quality: 'hepsi', lang: 'hepsi', limit: 80 }
    if (!vs.length) { govde.append(h('div', { class: 'bos-liste' }, 'Bu içerik için hiç sürüm bulunamadı.')); return }
    // Süzgeç düğmeleri kalite gruplarıdır (1226p gibi sıra dışı değerler en yakın gruba katılır; bilinmeyen '?' en sonda).
    const quals = [...new Set(vs.map(v => qualityGroup(v.quality) || '?'))].sort((a, b) => (a === '?') - (b === '?') || QUALITY_RANK(b) - QUALITY_RANK(a))
    const langs = [...new Set(vs.flatMap(v => v.languages || []))].sort((a, b) => (b === 'tr') - (a === 'tr') || a.localeCompare(b))
    const hasNoLang = vs.some(v => !(v.languages || []).length)
    const qChips = ['hepsi', ...quals].map(q => h('button', { type: 'button', class: 'cip', 'aria-pressed': String(q === 'hepsi'), 'data-q': q }, q === 'hepsi' ? 'Tüm kaliteler' : (q === '?' ? 'Bilinmeyen' : qualityLabel(q))))
    const langSel = h('select', { 'aria-label': 'Dil süzgeci' },
      h('option', { value: 'hepsi' }, 'Tüm diller'),
      langs.map(l => h('option', { value: l }, langName(l))),
      hasNoLang ? h('option', { value: '-' }, 'Dil bilgisi yok') : null)
    const sortSel = h('select', { 'aria-label': 'Sıralama' },
      h('option', { value: 'seeders:-1' }, 'Kaynak sayısı (çoktan aza)'), h('option', { value: 'size:-1' }, 'Boyut (büyükten küçüğe)'), h('option', { value: 'size:1' }, 'Boyut (küçükten büyüğe)'),
      h('option', { value: 'quality:-1' }, 'Kalite (yüksekten düşüğe)'), h('option', { value: 'quality:1' }, 'Kalite (düşükten yükseğe)'))
    const sayac = h('span', { class: 'soluk sag' })
    const tbody = h('tbody')
    const ths = {}
    const thBtn = (key, ad) => { const b = h('button', { type: 'button', title: ad + ' sütununa göre sırala' }, ad); const th = h('th', { scope: 'col' }, b); b.addEventListener('click', () => { if (st.key === key) st.dir = -st.dir; else { st.key = key; st.dir = -1 } syncSort(); ciz() }); ths[key] = th; return th }
    const thead = h('thead', null, h('tr', null, thBtn('quality', 'Kalite'), thBtn('size', 'Boyut'), thBtn('seeders', 'Kaynak'), h('th', { scope: 'col' }, 'Dil'), h('th', { scope: 'col' }, 'Site'), h('th', { scope: 'col' }, 'Sürüm adı'), h('th', { scope: 'col' }, '')))
    function syncSort () {
      for (const [k, th] of Object.entries(ths)) { if (k === st.key) th.setAttribute('aria-sort', st.dir < 0 ? 'descending' : 'ascending'); else th.removeAttribute('aria-sort') }
      sortSel.value = `${st.key}:${st.dir}`
      if (sortSel.value !== `${st.key}:${st.dir}`) sortSel.selectedIndex = -1
    }
    sortSel.addEventListener('change', () => { const [k, d] = sortSel.value.split(':'); st.key = k; st.dir = +d; syncSort(); ciz() })
    langSel.addEventListener('change', () => { st.lang = langSel.value; st.limit = 80; ciz() })
    qChips.forEach(c => c.addEventListener('click', () => { st.quality = c.dataset.q; qChips.forEach(x => x.setAttribute('aria-pressed', String(x === c))); ciz() }))

    govde.append(
      h('div', { class: 'suzgec' }, qChips),
      h('div', { class: 'araclar' }, h('label', null, 'Sırala ', sortSel), h('label', null, 'Dil ', langSel), sayac),
      h('table', { class: 'surum' }, thead, tbody))
    syncSort()

    const keyVal = { seeders: v => v.seeders || 0, size: v => v.sizeBytes || (v.sizeGB || 0) * 1e9, quality: v => QUALITY_RANK(v.quality) }
    function ciz () {
      let l = vs.filter(v => (st.quality === 'hepsi' || (qualityGroup(v.quality) || '?') === st.quality) &&
        (st.lang === 'hepsi' || (st.lang === '-' ? !(v.languages || []).length : (v.languages || []).includes(st.lang))))
      const f = keyVal[st.key]
      l = [...l].sort((a, b) => (st.key === 'quality' ? compareQuality(a.quality, b.quality, st.dir) : st.dir * (f(a) - f(b))) || b.seeders - a.seeders)
      sayac.textContent = l.length + ' / ' + vs.length + ' sürüm'
      const rows = l.slice(0, st.limit).map(satir)
      if (l.length > st.limit) rows.push(h('tr', null, h('td', { colspan: '7' }, h('button', { class: 'dugme gri', onclick: () => { st.limit += 80; ciz() } }, `Daha fazla göster (${l.length - st.limit} sürüm daha)`))))
      tbody.replaceChildren(...(l.length ? rows : [h('tr', null, h('td', { colspan: '7' }, 'Bu süzgece uyan sürüm yok.'))]))
    }
    ciz()

    function satir (v) {
      const play = () => `${location.origin}/play/${type}/${id}/${v.infoHash}/${v.fileIdx ?? 'x'}`
      const td = (et, cls, ...k) => h('td', { 'data-et': et, class: cls }, ...k)
      const lang = (v.languages || []).map(c => h('span', { class: 'etiket', title: c.toUpperCase() }, langName(c)))
      const tags = [...(v.languageTags || []), ...(v.tags || [])].slice(0, 5).map(t => h('span', { class: 'etiket' }, t))
      const eylem = h('td', { class: 'islem' })
      const doldur = () => {
        const lib = v.library
        const lab = libraryLabel(lib)
        const var_ = lib && (lib.fileSelected === true || lib.fileSelected === null)
        if (var_) {
          const bitti = lib.fileComplete === true || (lib.fileComplete == null && lib.state === 'completed')
          eylem.replaceChildren(
            h('span', { class: 'durumMetin ' + (lab[1] || '') }, (bitti ? '✔ İndirildi' : lab[0])), ' ',
            bitti ? h('button', { class: 'dugme oynat kucuk', onclick: () => oynat({ id: v.infoHash, infoHash: v.infoHash, type, imdbId: imdb, videoId: id, fileIdx: v.fileIdx, title: data.id, name: v.name, state: lib.state, poster: '', playUrl: play() }) }, '▶ Oynat')
              : h('a', { class: 'dugme gri kucuk', href: '#/' }, 'İndirmelere git'))
          return
        }
        const b1 = h('button', { class: 'dugme gri kucuk', onclick: () => ekle(false, b1, b2) }, 'İndir')
        const b2 = h('button', { class: 'dugme kucuk', onclick: () => ekle(true, b1, b2) }, '▶ İndir + oynat')
        eylem.replaceChildren(b1, b2)
      }
      async function ekle (oyna, b1, b2) {
        const tab = oyna && !EMBED ? window.open('', '_blank') : null
        b1.disabled = b2.disabled = true
        try {
          const r = await post('/api/items', {
            infoHash: v.infoHash, files: v.fileIdx != null ? [v.fileIdx] : null, trackers: v.trackers || [], type, id,
            title: v.title || v.name, source: { title: v.title, quality: v.quality, sizeGB: v.sizeGB, seeders: v.seeders, site: v.source, languages: v.languages, languageText: v.languageText }
          })
          v.library = { state: r.item.state, fileSelected: true, fileComplete: r.item.state === 'completed' }
          doldur()
          toast(r.existed ? 'Bu torrent zaten kütüphanede; dosya seçime eklendi.' : 'İndirme başladı. “İndirmeler” sayfasından izleyebilirsin.', 'ok')
          if (oyna) {
            const f = (r.item.files || []).find(x => x.idx === v.fileIdx) || null
            oynat({ ...playDescriptor(r.item, f), videoId: id, playUrl: play() }, tab)
          }
        } catch (e) {
          if (tab) tab.close()
          b1.disabled = b2.disabled = false
          toast('Eklenemedi: ' + e.message, 'hata')
        }
      }
      doldur()
      const adSatiri = h('td', { class: 'ad', 'data-et': 'Ad' }, h('b', null, v.name || '—'), v.fileName && v.fileName !== v.name ? h('div', null, v.fileName) : null, h('div', null, tags))
      return h('tr', null,
        td('Kalite', 'kalite', h('span', { title: v.quality && qualityLabel(v.quality) !== v.quality ? 'Torrentio’nun bildirdiği: ' + v.quality : null }, qualityLabel(v.quality)), v.kind === 'pack' ? h('span', { class: 'etiket', title: 'Bu bölüm bir sezon paketinin içinden indirilir; yalnızca bu bölümün dosyası inecek. Bildirilen boyut bölümün ya da tüm paketin boyutu olabilir.' }, 'paketten') : null),
        td('Boyut', 'say', v.sizeGB ? (v.kind === 'pack' ? '≈ ' : '') + v.sizeGB.toFixed(2) + ' GB' : '—'),
        td('Kaynak', 'say', String(v.seeders ?? 0)),
        td('Dil', '', lang.length ? lang : h('span', { class: 'soluk', title: 'Dil bilgisi verilmemiş (çoğunlukla yalnız İngilizce)' }, '—')),
        td('Site', '', v.source || '—'),
        adSatiri, eylem)
    }
  }
}
route(/^\/surum\/(movie|series)\/(tt\d+(?::\d+:\d+)?)$/, viewSurum, 'ara')

// ───────────────────────── 5) Sezon seçici ─────────────────────────
async function viewSezon (root, imdb, seasonStr, current) {
  const season = +seasonStr
  const geri = h('a', { class: 'geri', href: `#/dizi/${imdb}` }, '← Sezonlara dön')
  const bant = h('div'); bant.append(baslikBandi(null, season === 0 ? 'Özel bölümler' : season + '. sezon'))
  const ic = h('div')
  root.append(geri, bant, ic)
  let titleInfo = null
  api(`/api/title?type=series&id=${imdb}`).then(t => {
    titleInfo = t
    if (!current()) return
    bant.replaceChildren(baslikBandi(t, season === 0 ? 'Özel bölümler' : season + '. sezon'))
    if (t.seasons.length > 1) {
      const sel = h('select', { 'aria-label': 'Sezon' }, t.seasons.map(s => h('option', { value: s.season, selected: s.season === season }, s.season === 0 ? 'Özel bölümler' : s.season + '. sezon')))
      sel.addEventListener('change', () => { location.hash = `#/sezon/${imdb}/${sel.value}` })
      bant.firstChild.lastChild.append(h('div', { style: 'margin-top:8px' }, sel))
    }
  }).catch(() => {})

  ic.append(yukleniyor('Sezonun bölümleri için Torrentio sorgulanıyor. Bu 10–40 saniye sürebilir…'))
  const yukle = async () => {
    ic.replaceChildren(yukleniyor('Sezonun bölümleri için Torrentio sorgulanıyor. Bu 10–40 saniye sürebilir…'))
    try {
      const [data, lib] = await Promise.all([api(`/api/season?id=${imdb}&season=${season}`), api('/api/items').catch(() => ({ items: [] }))])
      if (!current()) return
      ic.replaceChildren()
      kur(data, lib.items)
    } catch (e) { if (current()) ic.replaceChildren(hataKutusu('Sezon bilgisi alınamadı: ' + e.message, yukle)) }
  }
  yukle()

  function kur (data, libItems) {
    // kütüphanede olan bölümler: videoId -> { state, complete }
    const have = new Map()
    for (const it of libItems) for (const f of it.files || []) if (f.selected && f.videoId) have.set(f.videoId, { state: it.state, complete: f.complete })
    const epId = n => `${imdb}:${season}:${n}`
    const epTitle = new Map(data.episodes.map(e => [e.episode, e.title]))
    const st = { mode: data.packs.length ? 'paket' : 'bolum', pack: null, packInfo: null, packLoading: false, packSel: new Set(), shown: 10, q: 'auto', rows: new Map() }

    const modeBtns = [['paket', 'Sezon paketi'], ['bolum', 'Bölüm bölüm']].map(([k, ad]) =>
      h('button', { type: 'button', class: 'cip', 'data-m': k, 'aria-pressed': String(k === st.mode) }, ad))
    const icerik = h('div')
    const toplam = h('span', { class: 'toplam' }, '0 bölüm · 0 GB')
    const not = h('span', { class: 'not' })
    const indirBtn = h('button', { class: 'dugme', disabled: true }, '⬇ İndir')
    const altbar = h('div', { class: 'altbar' }, h('div', null, toplam, h('br'), not), indirBtn)
    ic.append(
      h('p', { class: 'soluk', style: 'margin:0 0 10px' }, `${data.episodeCount} bölüm. Boyutlar torrent sitelerinin bildirdiği değerlerdir; sınır yok, karar senin.`),
      h('div', { class: 'suzgec' }, modeBtns), icerik)
    document.body.append(altbar)

    modeBtns.forEach(b => b.addEventListener('click', () => { st.mode = b.dataset.m; modeBtns.forEach(x => x.setAttribute('aria-pressed', String(x === b))); ciz() }))

    // ── özet
    function ozet () {
      let n = 0; let bytes = 0; let unknown = 0
      if (st.mode === 'paket') {
        n = st.packSel.size
        if (st.packInfo) for (const e of st.packInfo.episodes) if (st.packSel.has(e.episode)) { if (e.length) bytes += e.length; else unknown++ }
      } else {
        for (const [no, r] of st.rows) {
          if (!r.on) continue
          n++
          const o = r.opts[r.sel]
          if (o && o.sizeBytes) bytes += o.sizeBytes; else unknown++
        }
      }
      toplam.textContent = `${n} bölüm · ${(bytes / 1e9).toFixed(2)} GB`
      const parts = []
      if (unknown) parts.push(`${unknown} bölümün boyutu bilinmiyor`)
      if (st.mode === 'paket' && !st.pack) parts.push('önce bir paket seç')
      if (st.mode === 'paket' && st.pack && st.packLoading) parts.push('dosya listesi alınıyor…')
      not.textContent = parts.join(' · ')
      indirBtn.disabled = n === 0 || (st.mode === 'paket' && (!st.pack || st.packLoading))
    }

    // ── paket kipi
    const packSize = p => p.seasonGB != null ? { gb: p.seasonGB, txt: p.seasonGB.toFixed(2) + ' GB' }
      : p.sizeKind === 'torrent' ? { gb: p.sizeGB, txt: '≈ ' + p.sizeGB.toFixed(2) + ' GB (tüm torrent)' } : { gb: p.sizeGB, txt: p.sizeGB ? '≈ ' + p.sizeGB.toFixed(2) + ' GB' : 'boyut bilinmiyor' }

    async function selectPack (p) {
      st.pack = p; st.packInfo = null; st.packSel = new Set(); st.packLoading = true
      ciz()
      try {
        const info = await api(`/api/torrents/${p.infoHash}/files?season=${season}`)
        if (st.pack !== p || !current()) return
        st.packInfo = { episodes: info.episodes.map(e => ({ episode: e.episode, fileIdx: e.fileIdx, length: e.length, name: e.name })), exact: true }
      } catch (e) {
        if (st.pack !== p || !current()) return
        toast('Paketin dosya listesi alınamadı (' + e.message + '). Torrentio’nun verisi kullanılıyor; boyutlar yaklaşık.', 'hata')
        st.packInfo = { episodes: p.episodes.map(e => ({ episode: e.episode, fileIdx: e.fileIdx, length: p.sizeKind === 'episode' ? (e.reportedBytes || 0) : 0, name: e.fileName })), exact: false }
      }
      st.packLoading = false
      for (const e of st.packInfo.episodes) if (!(have.get(epId(e.episode))?.complete)) st.packSel.add(e.episode)
      ciz()
    }

    function cizPaket () {
      if (!data.packs.length) { icerik.append(h('div', { class: 'bos-liste' }, 'Bu sezon için paket torrent bulunamadı. “Bölüm bölüm” kipini dene.')); return }
      icerik.append(h('p', { class: 'soluk' }, 'Bir paket seç; hangi bölümlerin ineceğini sonra işaretleyebilirsin.'))
      for (const p of data.packs.slice(0, st.shown)) {
        const sz = packSize(p)
        const secili = st.pack === p
        const kart = h('label', { class: 'paket' + (secili ? ' secili' : '') },
          h('div', { class: 'ust2' },
            h('input', { type: 'radio', name: 'paket', checked: secili, onchange: () => selectPack(p) }),
            h('b', { class: 'kalite' }, qualityLabel(p.quality)),
            h('span', null, `${p.episodeCount}/${data.episodeCount} bölüm`),
            h('span', { class: 'soluk' }, `${p.seeders} kaynak · ${p.source || '—'}`),
            (p.languages || []).slice(0, 3).map(c => h('span', { class: 'etiket' }, langName(c))),
            p.multiSeason ? h('span', { class: 'etiket', title: 'Birden çok sezon içeren paket; yalnızca bu sezonun bölümleri indirilir.' }, 'çok sezonlu') : null,
            p.library ? h('span', { class: 'durumMetin iniyor' }, 'kütüphanede') : null,
            h('span', { class: 'ozet' }, sz.txt)),
          h('small', null, p.name))
        icerik.append(kart)
        if (secili) icerik.append(cizPaketBolumleri())
      }
      if (data.packs.length > st.shown) icerik.append(h('button', { class: 'dugme gri', onclick: () => { st.shown += 15; ciz() } }, `Daha fazla paket göster (${data.packs.length - st.shown} tane daha)`))
    }
    function cizPaketBolumleri () {
      if (st.packLoading || !st.packInfo) return yukleniyor('Paketin dosya listesi alınıyor (en çok 90 sn)…')
      const info = st.packInfo
      if (!info.episodes.length) return h('div', { class: 'hatakutu' }, 'Bu paketin içinde bu sezona ait bölüm dosyası bulunamadı.')
      const kutu = h('div', { class: 'bolumler' })
      const rows = []
      const topla = (on) => { for (const r of rows) if (!r.dis) { r.cb.checked = on; yaz(r) } ozet() }
      const yaz = r => { if (r.cb.checked) st.packSel.add(r.e.episode); else st.packSel.delete(r.e.episode); r.el.classList.toggle('kapali', !r.cb.checked) }
      const ustBar = h('div', { class: 'araclar', style: 'margin:0;border-radius:0;border-width:0 0 1px' },
        h('button', { type: 'button', class: 'dugme gri kucuk', onclick: () => topla(true) }, 'Tümünü seç'),
        h('button', { type: 'button', class: 'dugme gri kucuk', onclick: () => topla(false) }, 'Hiçbirini seçme'),
        info.exact ? null : h('span', { class: 'soluk' }, 'Boyutlar yaklaşık'))
      kutu.append(ustBar)
      for (const e of info.episodes.slice().sort((a, b) => a.episode - b.episode)) {
        const hv = have.get(epId(e.episode))
        const dis = !!hv && hv.complete
        const cb = h('input', { type: 'checkbox', checked: st.packSel.has(e.episode), disabled: dis, 'aria-label': epCode(season, e.episode) })
        const el = h('div', { class: 'bolumSatiri' + (cb.checked ? '' : ' kapali') }, cb, h('span', { class: 'no' }, epCode(season, e.episode)),
          h('span', { class: 'ad' }, epTitle.get(e.episode) || e.name || '', hv ? h('span', { class: 'durumMetin ' + (hv.complete ? '' : 'iniyor'), style: 'margin-left:8px' }, hv.complete ? '✔ indirildi' : STATE_TR[hv.state]) : null),
          h('span', { class: 'gb' }, e.length ? fmtBytes(e.length) : '—'))
        const r = { e, cb, el, dis }
        cb.addEventListener('change', () => { yaz(r); ozet() })
        rows.push(r); kutu.append(el)
      }
      return kutu
    }

    // ── bölüm bölüm kipi
    const pick = pickOption // kalite grupla eşlenir (E6); yardimci.js
    function kurSatirlar () {
      for (const e of data.episodes) {
        const opts = e.options || []
        const hv = have.get(e.id)
        const ex = st.rows.get(e.episode)
        st.rows.set(e.episode, { e, opts, sel: pick(opts, st.q), on: ex ? ex.on : (opts.length > 0 && !(hv && hv.complete)) })
      }
    }
    kurSatirlar()
    const qualities = qualityGroups(data.episodes.flatMap(e => e.options || []))
    const optText = o => `${qualityLabel(o.quality)} · ${o.sizeGB ? o.sizeGB.toFixed(2) + ' GB' : '? GB'} · ${o.seeders} kaynak · ${o.source || '—'}${(o.languages || []).length ? ' · ' + o.languages.map(langName).slice(0, 2).join('/') : ''}`

    function cizBolum () {
      if (!data.episodes.length) { icerik.append(h('div', { class: 'bos-liste' }, 'Bu sezonun bölüm listesi alınamadı.')); return }
      const qSel = h('select', { 'aria-label': 'Tercih edilen kalite' }, h('option', { value: 'auto' }, 'Otomatik (1080p / en çok kaynak)'), qualities.map(q => h('option', { value: q, selected: st.q === q }, q === '?' ? 'Bilinmeyen' : qualityLabel(q))))
      qSel.addEventListener('change', () => { st.q = qSel.value; for (const r of st.rows.values()) r.sel = pick(r.opts, st.q); ciz() })
      const topla = on => { for (const r of st.rows.values()) r.on = on && r.opts.length > 0 && !(have.get(r.e.id)?.complete); ciz() }
      const kutu = h('div', { class: 'bolumler' })
      icerik.append(
        h('div', { class: 'araclar' }, h('label', null, 'Kalite ', qSel),
          h('button', { type: 'button', class: 'dugme gri kucuk', onclick: () => topla(true) }, 'Tümünü seç'),
          h('button', { type: 'button', class: 'dugme gri kucuk', onclick: () => topla(false) }, 'Hiçbirini seçme')), kutu)
      for (const r of st.rows.values()) {
        const hv = have.get(r.e.id)
        const dis = (hv && hv.complete) || !r.opts.length
        const cb = h('input', { type: 'checkbox', checked: r.on && !dis, disabled: dis, 'aria-label': epCode(season, r.e.episode) })
        const gb = h('span', { class: 'gb' })
        const sel = r.opts.length ? h('select', { 'aria-label': 'Sürüm', disabled: dis }, r.opts.slice(0, 40).map((o, i) => h('option', { value: i, selected: i === r.sel }, optText(o)))) : null
        const yaz = () => { const o = r.opts[r.sel]; gb.textContent = o && o.sizeBytes ? fmtBytes(o.sizeBytes) : '—'; row.classList.toggle('kapali', !r.on) }
        const row = h('div', { class: 'bolumSatiri' }, cb, h('span', { class: 'no' }, epCode(season, r.e.episode)),
          h('span', { class: 'ad' }, r.e.title || '', hv ? h('span', { class: 'durumMetin ' + (hv.complete ? '' : 'iniyor'), style: 'margin-left:8px' }, hv.complete ? '✔ indirildi' : STATE_TR[hv.state]) : null,
            !r.opts.length ? h('span', { class: 'soluk', style: 'margin-left:8px' }, r.e.error ? 'sürüm alınamadı' : 'sürüm yok') : null),
          gb, sel)
        cb.addEventListener('change', () => { r.on = cb.checked; yaz(); ozet() })
        if (sel) sel.addEventListener('change', () => { r.sel = +sel.value; yaz(); ozet() })
        yaz(); kutu.append(row)
      }
    }

    function ciz () { icerik.replaceChildren(); (st.mode === 'paket' ? cizPaket : cizBolum)(); ozet() }

    // ── indir
    indirBtn.addEventListener('click', async () => {
      indirBtn.disabled = true; indirBtn.textContent = 'Ekleniyor…'
      const groups = new Map() // infoHash -> { files:Set|null, first, trackers, title, source }
      const addTo = (hash, fileIdx, epNo, meta) => {
        let g = groups.get(hash)
        if (!g) { g = { files: new Set(), noFile: false, first: epNo, ...meta }; groups.set(hash, g) }
        if (fileIdx == null) g.noFile = true; else g.files.add(fileIdx)
        g.first = Math.min(g.first, epNo)
        g.n = (g.n || 0) + 1
      }
      if (st.mode === 'paket') {
        const p = st.pack
        const meta = { trackers: p.trackers || [], title: p.name, source: { title: p.name, quality: p.quality, sizeGB: p.seasonGB ?? p.sizeGB, seeders: p.seeders, site: p.source, languages: p.languages } }
        for (const e of st.packInfo.episodes) if (st.packSel.has(e.episode)) addTo(p.infoHash, e.fileIdx, e.episode, meta)
      } else {
        for (const r of st.rows.values()) {
          if (!r.on) continue
          const o = r.opts[r.sel]; if (!o) continue
          addTo(o.infoHash, o.fileIdx, r.e.episode, { trackers: o.trackers || [], title: o.title || o.name, source: { title: o.title, quality: o.quality, sizeGB: o.sizeGB, seeders: o.seeders, site: o.source, languages: o.languages } })
        }
      }
      let ok = 0; let eps = 0; const errs = []
      for (const [hash, g] of groups) {
        try {
          await post('/api/items', { infoHash: hash, files: g.noFile ? null : [...g.files], trackers: g.trackers, type: 'series', id: epId(g.first), title: g.title, source: g.source })
          ok++; eps += g.n
        } catch (e) { errs.push(e.message) }
      }
      indirBtn.textContent = '⬇ İndir'
      if (ok) toast(`${eps} bölüm indirmeye alındı.`, 'ok')
      if (errs.length) toast(`${errs.length} torrent eklenemedi: ${errs[0]}`, 'hata')
      if (ok && !errs.length) location.hash = '#/'
      else ozet()
    })

    ciz()
  }
  return () => { document.querySelectorAll('.altbar').forEach(e => e.remove()) }
}
route(/^\/sezon\/(tt\d+)\/(\d+)$/, viewSezon, 'ara')

if (!location.hash) location.hash = '#/'
render()
