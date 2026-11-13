// Stremio "Offline İndir" — yerel eklenti + indirme servisi.
// Akış listesine "İndir+Oynat" satırları ekler; tıklanınca torrent diske iner
// ve aynı anda Stremio'nun oynatıcısına akıtılır. Biten dosyalar offline oynar.

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import WebTorrent from 'webtorrent'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(ROOT, 'data')
const IMG = path.join(DATA, 'img')
const META = path.join(DATA, 'meta')
const CONFIG_FILE = path.join(ROOT, 'config.json')
const LIB_FILE = path.join(DATA, 'library.json')

const DEFAULTS = {
  port: 11480,
  downloadDir: path.join(os.homedir(), 'Videos', 'Stremio-Offline'),
  // Torrentio'yu ayarlı kullanıyorsan buraya kendi adresini yaz
  // (ör. https://torrentio.strem.fun/qualityfilter=480p) — sonunda /manifest.json olmadan.
  torrentioUrl: 'https://torrentio.strem.fun',
  // false: indirme bitince torrent kapatılır, paylaşım (seed) yapılmaz.
  seedAfterDownload: false,
  // Akış listesinde her Torrentio sonucu için "İndir+Oynat" satırı gösterilsin mi?
  showDownloadRows: true,
  // Kart menüsündeki "Cihaza indir" hangi sürümü seçsin: bu kalite, bu boyutun altı, en çok kaynaklı olan.
  autoQuality: '1080p',
  autoMaxSizeGB: 12,
  // Stremio arayüzüne düğme eklemek için kullanılan hata ayıklama kapısı (Stremio başlatıcıyla açılmalı).
  debugPort: 11481
}

fs.mkdirSync(IMG, { recursive: true })
fs.mkdirSync(META, { recursive: true })
let fileCfg = {}
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch {}
const cfg = { ...DEFAULTS, ...fileCfg }
fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
fs.mkdirSync(cfg.downloadDir, { recursive: true })

const BASE = `http://127.0.0.1:${cfg.port}`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|webm|ts|wmv|mpg|mpeg|flv)$/i
const MIME = { '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t' }
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce'
]

const log = (...a) => console.log(new Date().toLocaleTimeString('tr-TR'), ...a)

// ---------------------------------------------------------------- kütüphane

/** key -> kayıt. key = `${infoHash}:${fileIdx}` */
const lib = new Map()
try {
  for (const e of JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'))) lib.set(e.key, e)
} catch {}

let saveTimer = null
function saveLib () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const out = [...lib.values()].map(({ speed, peers, ...rest }) => rest)
    fs.writeFileSync(LIB_FILE, JSON.stringify(out, null, 2))
  }, 300)
}

const parseId = id => {
  const [imdbId, season, episode] = String(id).split(':')
  return { imdbId, season: season ? +season : null, episode: episode ? +episode : null }
}

// ---------------------------------------------------------------- torrent

const client = new WebTorrent()
client.on('error', e => log('webtorrent hata:', e.message))

const pending = new Map() // key -> akış listesinden gelen bilgi (başlık, tracker'lar)
const active = new Map() // infoHash -> Promise<torrent>
const wired = new Map() // key -> webtorrent File

function getTorrent (infoHash, trackers = []) {
  let p = active.get(infoHash)
  if (p) return p
  p = new Promise((resolve, reject) => {
    const tr = [...new Set([...trackers, ...DEFAULT_TRACKERS])]
    const magnet = `magnet:?xt=urn:btih:${infoHash}` + tr.map(t => `&tr=${encodeURIComponent(t)}`).join('')
    const t = client.add(magnet, { path: cfg.downloadDir, deselect: true })
    const timer = setTimeout(() => {
      active.delete(infoHash)
      client.remove(infoHash).catch(() => {})
      reject(new Error('Torrent bilgisi 90 sn içinde alınamadı (kaynak yok olabilir)'))
    }, 90_000)
    t.once('ready', () => { clearTimeout(timer); resolve(t) })
    t.once('error', e => { clearTimeout(timer); active.delete(infoHash); reject(e) })
  })
  active.set(infoHash, p)
  return p
}

function pickFile (t, fileIdx) {
  if (Number.isInteger(fileIdx) && t.files[fileIdx]) return t.files[fileIdx]
  return t.files.filter(f => VIDEO_EXT.test(f.name)).sort((a, b) => b.length - a.length)[0] ||
    [...t.files].sort((a, b) => b.length - a.length)[0]
}

/** Kaydın torrent dosyasını hazırlar, indirmeyi (tamamını) başlatır. */
async function ensureFile (entry) {
  if (wired.has(entry.key)) return wired.get(entry.key)
  const t = await getTorrent(entry.infoHash, entry.trackers)
  if (wired.has(entry.key)) return wired.get(entry.key)
  const file = pickFile(t, entry.fileIdx)
  if (!file) throw new Error('Torrentte oynatılabilir dosya yok')
  wired.set(entry.key, file)
  entry.fileName = file.name
  entry.size = file.length
  entry.filePath = path.join(t.path, file.path)
  const finish = () => onFileDone(entry, t)
  if (file.done) finish()
  else { file.select(); file.once('done', finish) }
  saveLib()
  return file
}

function onFileDone (entry, t) {
  if (entry.state === 'done') return
  entry.state = 'done'
  entry.progress = 1
  entry.doneAt = Date.now()
  saveLib()
  log('✔ indirildi:', entry.fileName)
  if (cfg.seedAfterDownload) return
  // Aynı torrentten hâlâ inen başka dosya yoksa torrenti kapat (seed yok).
  const busy = [...lib.values()].some(e => e.infoHash === entry.infoHash && e.state !== 'done')
  if (!busy) setTimeout(() => closeTorrent(entry.infoHash, false), 1500)
}

async function closeTorrent (infoHash, destroyStore) {
  for (const [k] of wired) if (k.startsWith(infoHash + ':')) wired.delete(k)
  if (!active.has(infoHash)) return
  active.delete(infoHash)
  try { await client.remove(infoHash, { destroyStore }) } catch {}
}

setInterval(() => {
  let dirty = false
  for (const [key, file] of wired) {
    const e = lib.get(key)
    if (!e || e.state === 'done') continue
    const t = file._torrent
    e.progress = file.progress
    e.speed = t?.downloadSpeed || 0
    e.peers = t?.numPeers || 0
    dirty = true
  }
  if (dirty) saveLib()
}, 3000)

// ---------------------------------------------------------------- meta (offline için)

async function getJson (url, ms = 9000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

async function saveImage (url, name) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) return
    await fsp.writeFile(path.join(IMG, name), Buffer.from(await r.arrayBuffer()))
  } catch {}
}

async function cacheMeta (entry) {
  const file = path.join(META, entry.imdbId + '.json')
  try {
    let meta
    if (fs.existsSync(file)) meta = JSON.parse(await fsp.readFile(file, 'utf8'))
    else {
      meta = (await getJson(`https://v3-cinemeta.strem.io/meta/${entry.type}/${entry.imdbId}.json`)).meta
      if (!meta) return
      await fsp.writeFile(file, JSON.stringify(meta))
      if (meta.poster) await saveImage(meta.poster, `${entry.imdbId}-poster`)
      if (meta.background) await saveImage(meta.background, `${entry.imdbId}-background`)
      if (meta.logo) await saveImage(meta.logo, `${entry.imdbId}-logo`)
    }
    entry.name = meta.name
    saveLib()
  } catch (e) { log('meta alınamadı:', e.message) }
}

const localImg = (imdbId, kind, fallback) =>
  fs.existsSync(path.join(IMG, `${imdbId}-${kind}`)) ? `${BASE}/img/${imdbId}-${kind}` : fallback

function readMeta (imdbId) {
  try { return JSON.parse(fs.readFileSync(path.join(META, imdbId + '.json'), 'utf8')) } catch { return null }
}

// ---------------------------------------------------------------- eklenti yanıtları

const manifest = {
  id: 'local.stremio.offline-indir',
  version: '1.0.0',
  name: 'Offline İndir',
  description: 'Torrentio sonuçlarını tek tıkla cihaza indirir ve indirirken oynatır. İnenler internetsiz izlenir.',
  logo: `${BASE}/logo.svg`,
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  resources: ['stream', 'catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  catalogs: [
    { type: 'movie', id: 'offline-movies', name: 'İndirilenler' },
    { type: 'series', id: 'offline-series', name: 'İndirilenler' }
  ],
  behaviorHints: { configurable: false }
}

const playUrl = (type, id, infoHash, fileIdx) =>
  `${BASE}/play/${type}/${encodeURIComponent(id)}/${infoHash}/${Number.isInteger(fileIdx) ? fileIdx : 'x'}`

const fmtSize = n => !n ? '' : n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(0) + ' MB'
const hints = fileName => ({ notWebReady: !/\.mp4$/i.test(fileName || ''), ...(fileName ? { filename: fileName } : {}) })

async function streamsFor (type, id) {
  const streams = []
  const have = new Set()
  for (const e of lib.values()) {
    if (e.id !== id) continue
    have.add(e.key)
    const done = e.state === 'done' && e.filePath && fs.existsSync(e.filePath)
    streams.push({
      name: done ? '💾 Offline\nHazır' : `⏬ İniyor\n%${Math.floor((e.progress || 0) * 100)}`,
      description: `${e.fileName || e.title || ''}\n${fmtSize(e.size)}${done ? ' · internetsiz oynar' : ' · izlerken inmeye devam eder'}`,
      url: playUrl(type, id, e.infoHash, e.fileIdx),
      behaviorHints: hints(e.fileName)
    })
  }
  if (!cfg.showDownloadRows) return { streams }
  try {
    for (const t of await fetchTorrentio(type, id)) {
      if (have.has(t.key)) continue
      streams.push({
        name: `⬇ İndir+Oynat\n${t.quality}`.trim(),
        description: t.title,
        url: playUrl(type, id, t.infoHash, t.fileIdx),
        behaviorHints: hints(t.fileName)
      })
    }
  } catch (e) {
    if (!streams.length) log('Torrentio yanıt vermedi (offline olabilir):', e.message)
  }
  return { streams }
}

/** Torrentio sonuçlarını çözümler ve sonradan indirme başlatılabilsin diye `pending`e yazar. */
async function fetchTorrentio (type, id) {
  const data = await getJson(`${cfg.torrentioUrl.replace(/\/+$/, '')}/stream/${type}/${encodeURIComponent(id)}.json`)
  const out = []
  for (const s of data.streams || []) {
    if (!s.infoHash) continue
    const infoHash = s.infoHash.toLowerCase()
    const fileIdx = Number.isInteger(s.fileIdx) ? s.fileIdx : null
    const key = `${infoHash}:${fileIdx ?? 'x'}`
    const title = s.title || s.description || ''
    const size = /💾\s*([\d.]+)\s*(GB|MB)/i.exec(title)
    const item = {
      key, type, id, infoHash, fileIdx, title,
      trackers: (s.sources || []).filter(x => x.startsWith('tracker:')).map(x => x.slice(8)),
      fileName: s.behaviorHints?.filename,
      quality: (s.name || '').split('\n').slice(1).join(' '),
      seeders: +(/👤\s*(\d+)/.exec(title)?.[1] || 0),
      sizeGB: size ? +size[1] / (size[2].toUpperCase() === 'MB' ? 1000 : 1) : 0
    }
    pending.set(key, item)
    out.push(item)
  }
  return out
}

// ---------------------------------------------------------------- doğrudan indirme (menü düğmeleri)

function createEntry ({ type, id, infoHash, fileIdx, title, fileName, trackers }) {
  const key = `${infoHash}:${fileIdx ?? 'x'}`
  const p = pending.get(key) || {}
  const entry = {
    key, infoHash, fileIdx: fileIdx ?? null, type, id, ...parseId(id),
    title: title || p.title || '', fileName: fileName || p.fileName || '',
    trackers: trackers?.length ? trackers : p.trackers || [],
    state: 'downloading', progress: 0, addedAt: Date.now()
  }
  lib.set(key, entry)
  saveLib()
  log('⬇ indirme başladı:', entry.fileName || entry.title.split('\n')[0] || key)
  cacheMeta(entry)
  return entry
}

const hasFile = e => e.state === 'done' && e.filePath && fs.existsSync(e.filePath)
const shortName = e => e.fileName || (e.title || '').split('\n')[0] || 'içerik'

/** Oynatmadan, arka planda indirmeyi başlatır. */
function apiDownload (b) {
  const infoHash = String(b.infoHash || '').toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(infoHash)) throw new Error('Bu akış torrent değil, indirilemez')
  if (!['movie', 'series'].includes(b.type) || !/^tt\d+/.test(b.id || '')) throw new Error('Bu içerik türü desteklenmiyor')
  const fileIdx = Number.isInteger(b.fileIdx) ? b.fileIdx : null
  let entry = lib.get(`${infoHash}:${fileIdx ?? 'x'}`)
  if (entry && hasFile(entry)) return { ok: true, state: 'done', message: `Zaten indirilmiş: ${shortName(entry)}` }
  if (entry && entry.state !== 'done' && wired.has(entry.key)) {
    return { ok: true, state: 'downloading', message: `Zaten iniyor (%${Math.floor((entry.progress || 0) * 100)}): ${shortName(entry)}` }
  }
  if (entry) { entry.state = 'downloading'; entry.progress = 0; delete entry.error } else {
    entry = createEntry({ type: b.type, id: b.id, infoHash, fileIdx, title: String(b.title || ''), fileName: b.fileName, trackers: Array.isArray(b.trackers) ? b.trackers.filter(t => typeof t === 'string') : [] })
  }
  ensureFile(entry).catch(e => { entry.error = e.message; saveLib(); log('indirme başlamadı:', shortName(entry), '-', e.message) })
  return { ok: true, state: 'downloading', message: `İndirme başladı: ${shortName(entry)}` }
}

/** Kart menüsü: sürümü kendisi seçer (ayarlardaki kalite, boyut sınırı, en çok kaynak). */
async function apiAuto (b) {
  if (!['movie', 'series'].includes(b.type) || !/^tt\d+/.test(b.id || '')) throw new Error('Bu içerik türü desteklenmiyor')
  const existing = [...lib.values()].find(e => e.id === b.id && (hasFile(e) || e.state !== 'done'))
  if (existing) {
    return { ok: true, state: existing.state, message: hasFile(existing) ? `Zaten indirilmiş: ${shortName(existing)}` : `Zaten iniyor (%${Math.floor((existing.progress || 0) * 100)}): ${shortName(existing)}` }
  }
  const list = (await fetchTorrentio(b.type, b.id)).filter(t => t.seeders > 0)
  if (!list.length) throw new Error('Kaynağı olan bir torrent bulunamadı')
  const bySeed = (a, c) => c.seeders - a.seeders
  const fits = t => !t.sizeGB || t.sizeGB <= cfg.autoMaxSizeGB
  const pick = list.filter(t => t.quality.includes(cfg.autoQuality) && fits(t)).sort(bySeed)[0] ||
    list.filter(fits).sort(bySeed)[0] || [...list].sort(bySeed)[0]
  apiDownload(pick)
  return { ok: true, state: 'downloading', message: `İndirme başladı: ${pick.quality || '?'} · ${pick.sizeGB ? pick.sizeGB.toFixed(1) + ' GB' : '?'} · 👤 ${pick.seeders}` }
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { reject(new Error('geçersiz istek')) } })
    req.on('error', reject)
  })
}

function catalogFor (type) {
  const seen = new Map()
  for (const e of [...lib.values()].sort((a, b) => b.addedAt - a.addedAt)) {
    if (e.type !== type || seen.has(e.imdbId)) continue
    const meta = readMeta(e.imdbId)
    seen.set(e.imdbId, {
      id: e.imdbId,
      type,
      name: meta?.name || e.name || e.fileName || e.imdbId,
      poster: localImg(e.imdbId, 'poster', meta?.poster),
      posterShape: 'poster',
      description: meta?.description,
      releaseInfo: meta?.releaseInfo
    })
  }
  return { metas: [...seen.values()] }
}

function metaFor (type, imdbId) {
  const entries = [...lib.values()].filter(e => e.imdbId === imdbId)
  const meta = entries.length && readMeta(imdbId)
  if (!meta) return null
  meta.poster = localImg(imdbId, 'poster', meta.poster)
  meta.background = localImg(imdbId, 'background', meta.background)
  meta.logo = localImg(imdbId, 'logo', meta.logo)
  if (type === 'series' && Array.isArray(meta.videos)) {
    const ids = new Set(entries.map(e => e.id))
    meta.videos = meta.videos.filter(v => ids.has(v.id)).map(v => ({ ...v, thumbnail: undefined }))
  }
  return { meta }
}

// ---------------------------------------------------------------- oynatma

function parseRange (header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '')
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start, end
  if (m[1] === '') { start = Math.max(0, size - +m[2]); end = size - 1 } else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1) }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

function sendHead (req, res, size, name) {
  const range = parseRange(req.headers.range, size)
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    return null
  }
  const { start, end } = range || { start: 0, end: size - 1 }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
  })
  if (req.method === 'HEAD') { res.end(); return null }
  return { start, end }
}

async function handlePlay (req, res, [type, id, infoHash, idxRaw]) {
  infoHash = String(infoHash).toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(infoHash)) return json(res, 400, { err: 'geçersiz infoHash' })
  const fileIdx = /^\d+$/.test(idxRaw) ? +idxRaw : null
  const key = `${infoHash}:${fileIdx ?? 'x'}`
  let entry = lib.get(key)

  if (entry?.state === 'done') {
    if (entry.filePath && fs.existsSync(entry.filePath)) {
      const size = fs.statSync(entry.filePath).size
      const r = sendHead(req, res, size, entry.filePath)
      if (r) fs.createReadStream(entry.filePath, r).on('error', () => res.destroy()).pipe(res)
      return
    }
    entry.state = 'downloading' // dosya silinmiş: yeniden indir
    entry.progress = 0
  }

  if (!entry) entry = createEntry({ type, id, infoHash, fileIdx })

  const file = await ensureFile(entry)
  const r = sendHead(req, res, file.length, file.name)
  if (!r) return
  const it = file[Symbol.asyncIterator](r)
  let closed = false
  const onClose = new Promise(resolve => res.once('close', () => {
    closed = true
    try { it.destroy?.() ?? it.return?.() } catch {}
    resolve()
  }))
  try {
    for await (const chunk of it) {
      if (closed) break
      if (!res.write(chunk)) await Promise.race([new Promise(resolve => res.once('drain', resolve)), onClose])
    }
  } catch {}
  res.end()
}

// ---------------------------------------------------------------- yönetim

async function deleteEntry (key) {
  const e = lib.get(key)
  if (!e) return false
  lib.delete(key)
  const file = wired.get(key)
  wired.delete(key)
  saveLib()
  const others = [...lib.values()].some(x => x.infoHash === e.infoHash)
  if (!others) await closeTorrent(e.infoHash, false)
  else if (e.state !== 'done') { try { file?.deselect() } catch {} }
  if (e.filePath) {
    await fsp.rm(e.filePath, { force: true }).catch(() => {})
    // Boş kalan torrent klasörünü temizle (indirme klasörünün kendisine dokunma).
    const dir = path.dirname(e.filePath)
    if (path.resolve(dir) !== path.resolve(cfg.downloadDir)) await fsp.rmdir(dir).catch(() => {})
  }
  if (![...lib.values()].some(x => x.imdbId === e.imdbId)) {
    await fsp.rm(path.join(META, e.imdbId + '.json'), { force: true }).catch(() => {})
    for (const k of ['poster', 'background', 'logo']) await fsp.rm(path.join(IMG, `${e.imdbId}-${k}`), { force: true }).catch(() => {})
  }
  log('🗑 silindi:', e.fileName || key)
  return true
}

const libraryView = () => [...lib.values()].sort((a, b) => b.addedAt - a.addedAt).map(e => ({
  key: e.key,
  name: e.name || '',
  episode: e.season != null ? `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}` : '',
  fileName: e.fileName,
  size: e.size || 0,
  state: e.state,
  error: e.state === 'done' ? '' : e.error || '',
  progress: e.progress || 0,
  speed: e.state === 'done' ? 0 : e.speed || 0,
  peers: e.state === 'done' ? 0 : e.peers || 0,
  poster: localImg(e.imdbId, 'poster', ''),
  play: playUrl(e.type, e.id, e.infoHash, e.fileIdx)
}))

// ---------------------------------------------------------------- http

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Private-Network': 'true'
}

function json (res, code, body, extra = {}) {
  if (res.headersSent) return res.end()
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f1b3a"/><path d="M32 12v26m0 0-11-11m11 11 11-11M16 48h32" fill="none" stroke="#9d8cff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE)
    const parts = url.pathname.replace(/\.json$/, '').split('/').filter(Boolean).map(decodeURIComponent)

    // Yönetim uçları: yalnızca bu sayfanın kendisinden çağrılabilir (CORS yok).
    if (parts[0] === 'api') {
      const origin = req.headers.origin
      // İndirme başlatma uçları Stremio arayüzünden de çağrılabilir; silme yalnızca panelden.
      const fromStremio = origin === 'https://web.stremio.com' && (parts[1] === 'download' || parts[1] === 'auto')
      if (origin && origin !== BASE && origin !== `http://localhost:${cfg.port}` && !fromStremio) return json(res, 403, { err: 'yasak' })
      if (fromStremio) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Headers', 'content-type')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
        if (req.method === 'OPTIONS') return res.writeHead(204).end()
      }
      if ((parts[1] === 'download' || parts[1] === 'auto') && req.method === 'POST') {
        try {
          const body = await readBody(req)
          return json(res, 200, parts[1] === 'auto' ? await apiAuto(body) : apiDownload(body))
        } catch (e) { return json(res, 400, { err: e.message }) }
      }
      if (parts[1] === 'library' && req.method === 'GET') return json(res, 200, { downloadDir: cfg.downloadDir, items: libraryView() })
      if (parts[1] === 'delete' && req.method === 'POST') return json(res, 200, { ok: await deleteEntry(url.searchParams.get('key')) })
      return json(res, 404, { err: 'yok' })
    }

    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { err: 'yöntem desteklenmiyor' })

    if (parts[0] === 'play' && parts.length === 5) return await handlePlay(req, res, parts.slice(1))
    if (parts[0] === 'manifest') return json(res, 200, manifest)
    if (parts[0] === 'stream' && parts.length === 3) return json(res, 200, await streamsFor(parts[1], parts[2]))
    if (parts[0] === 'catalog' && parts.length >= 3) return json(res, 200, catalogFor(parts[1]))
    if (parts[0] === 'meta' && parts.length === 3) {
      const m = metaFor(parts[1], parts[2])
      return m ? json(res, 200, m) : json(res, 404, { err: 'kütüphanede yok' })
    }
    if (parts[0] === 'img' && parts.length === 2 && /^tt\d+-(poster|background|logo)$/.test(parts[1])) {
      const f = path.join(IMG, parts[1])
      if (!fs.existsSync(f)) return res.writeHead(404).end()
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' })
      return fs.createReadStream(f).pipe(res)
    }
    if (parts[0] === 'logo.svg') return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(LOGO)
    if (parts.length === 0) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(await fsp.readFile(path.join(ROOT, 'panel.html')))
    }
    json(res, 404, { err: 'yok' })
  } catch (e) {
    log('istek hatası:', req.url, '-', e.message)
    if (!res.headersSent) json(res, 502, { err: e.message })
    else res.destroy()
  }
})

server.listen(cfg.port, '127.0.0.1', () => {
  log(`Offline İndir çalışıyor → ${BASE}`)
  log(`İndirme klasörü: ${cfg.downloadDir}`)
  // Yarım kalan indirmeleri sürdür.
  for (const e of lib.values()) {
    if (e.state !== 'done') ensureFile(e).then(() => log('↻ sürdürülüyor:', e.fileName)).catch(err => log('sürdürülemedi:', e.fileName, '-', err.message))
  }
})

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${cfg.port} kullanımda — servis zaten çalışıyor olabilir.` : e)
  process.exit(1)
})

// ---------------------------------------------------------------- Stremio arayüzüne düğme ekleme
// Stremio başlatıcıyla (hata ayıklama kapısı açık) çalışıyorsa inject.js'i arayüze yükler.

const injected = new Map() // hedef kimliği -> WebSocket

async function injectTick () {
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${cfg.debugPort}/json`, { signal: AbortSignal.timeout(1500) })).json()
  } catch { return }
  for (const t of targets) {
    if (t.type !== 'page' || !String(t.url).startsWith('https://web.stremio.com') || injected.has(t.id)) continue
    let source
    try { source = (await fsp.readFile(path.join(ROOT, 'inject.js'), 'utf8')).replaceAll('__API__', BASE) } catch { return }
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    injected.set(t.id, ws)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }))
      // Sayfa yenilenirse de yeniden yüklensin; şu anki sayfaya da hemen uygula.
      ws.send(JSON.stringify({ id: 2, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source } }))
      ws.send(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: source } }))
      log('Stremio arayüzüne indirme düğmeleri eklendi')
    }
    ws.onclose = ws.onerror = () => injected.delete(t.id)
  }
}
setInterval(injectTick, 4000)
injectTick()

function shutdown () {
  clearTimeout(saveTimer)
  try { fs.writeFileSync(LIB_FILE, JSON.stringify([...lib.values()].map(({ speed, peers, ...r }) => r), null, 2)) } catch {}
  client.destroy(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
