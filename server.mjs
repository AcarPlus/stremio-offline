// Stremio "Offline İndir" — yerel eklenti + indirme servisi (motor: rqbit).
// Modüller: lib/engine (rqbit alt süreci), lib/pool (indirme başına motor süreçleri), lib/manager (indirme yöneticisi), lib/torrentio,
// lib/addon (Stremio uçları), lib/api (arayüz API'si, docs/api.md), lib/play (oynatma).
//
// Sınama için ortam değişkenleri: OFFLINE_PORT, OFFLINE_DATA_DIR, OFFLINE_DOWNLOAD_DIR,
// OFFLINE_RQBIT_PORT, OFFLINE_PEER_PORT (ayrıntı: docs/api.md "Ortam değişkenleri").

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from './lib/config.mjs'
import { log, setLogFile } from './lib/log.mjs'
import { EnginePool } from './lib/pool.mjs'
import { Settings } from './lib/settings.mjs'
import { migrateSession } from './lib/gecis.mjs'
import { Library } from './lib/library.mjs'
import { MetaStore } from './lib/meta.mjs'
import { Manager } from './lib/manager.mjs'
import { Torrentio } from './lib/torrentio.mjs'
import { Addon } from './lib/addon.mjs'
import { Api } from './lib/api.mjs'
import { servePlay } from './lib/play.mjs'
import { startInjector } from './lib/inject.mjs'
import { startKisayolBekci } from './lib/kisayol-bekci.mjs'
import { Kapatma } from './lib/kapat.mjs'
import { Guncelleme } from './lib/guncelleme.mjs'
import { Klip } from './lib/klip.mjs'

// Yakalanmamış hata servisi kapatmaz: günlüğe yazılır, servis sürer.
// Ayrıca stderr'e de yazılır: başlatıcı (baslat-servis.vbs) stderr'i data\baslatici.log'a ekler, açılışta çökme görünür kalır (E4).
process.on('uncaughtException', e => { log('yakalanmamış hata:', e); console.error('yakalanmamış hata:', e?.stack || e) })
process.on('unhandledRejection', e => { log('yakalanmamış ret:', e); console.error('yakalanmamış ret:', e?.stack || e) })

const cfg = loadConfig()

// Servis zaten çalışıyorsa (oturum açılışı kısayolu + elle başlatma gibi) sessizce çık:
// ne motoru başlatır ne de çalışan servisin motoruna dokunur.
async function alreadyRunning (c) {
  try {
    const r = await fetch(`${c.base}/manifest.json`, { signal: AbortSignal.timeout(1500) })
    const m = await r.json()
    return r.ok && typeof m.id === 'string' && /offline/i.test(m.id)
  } catch { return false }
}
if (await alreadyRunning(cfg)) process.exit(0)

setLogFile(path.join(cfg.dataDir, 'servis.log'))
// Kütüphane, ayarlar, motor havuzu ve yöneticiler kapı alındıktan SONRA kurulur (init, listen geri çağrısında):
// yarışı kaybeden örnek, kazananın dosyalarına (library.json, pid dosyaları) hiç dokunmadan çıkar (E9).
let library, settings, meta, manager, pool, torrentio, addon, api, kapat, guncelleme
let klip // klip (60 sn örnek): lib/klip.mjs
function init () {
  library = new Library(cfg.libFile).load()
  // Tek motorlu eski düzenden geçiş (bir kez; eski oturum klasörü yedeklenir, silinmez)
  try { migrateSession(cfg, library) } catch (e) { log('geçiş hatası:', e.message) }
  settings = new Settings(cfg)
  meta = new MetaStore(cfg)
  pool = new EnginePool(cfg, {
    limitsFor: ih => manager.limitsFor(ih),
    controlLimits: () => ({ down: 0, up: settings.get().uploadLimit }),
    slotsInUse: () => new Set(library.all().map(i => i.slot).filter(Number.isInteger))
  })
  manager = new Manager({ cfg, pool, library, meta, settings })
  torrentio = new Torrentio(cfg, meta)
  addon = new Addon({ cfg, manager, torrentio, meta })
  kapat = new Kapatma({ cfg, manager })
  kapat.start()
  guncelleme = new Guncelleme({ cfg, settings })
  guncelleme.start()
  api = new Api({ cfg, manager, torrentio, kapat, guncelleme })
  klip = new Klip({ cfg, manager, torrentio }).start()
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Private-Network': 'true'
}
const STREMIO_ORIGIN = 'https://web.stremio.com'

function json (res, code, body, extra = {}) {
  if (res.headersSent) return res.end()
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}


const WEB_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
async function serveWeb (res, name) {
  const type = WEB_TYPES[path.extname(name).toLowerCase()]
  if (!type || !/^[\w.-]+$/.test(name) || name.startsWith('.')) return json(res, 404, { err: 'yok' })
  try {
    const body = await fsp.readFile(path.join(cfg.root, 'web', name))
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    res.end(body)
  } catch { json(res, 404, { err: 'yok' }) }
}

async function handle (req, res) {
  // DNS yeniden bağlamaya karşı: Host başlığı servisin kendi adlarından (kendi portuyla) biri olmalı.
  if (!cfg.allowedHosts.has(String(req.headers.host || '').toLowerCase())) return json(res, 403, { err: 'geçersiz Host' })
  const url = new URL(req.url, cfg.base)
  let parts
  try {
    parts = url.pathname.replace(/\.json$/, '').split('/').filter(Boolean).map(decodeURIComponent)
  } catch { return json(res, 400, { err: 'geçersiz adres' }) }

  if (parts[0] === 'api') {
    // Yönetim uçları: servisin kendi sayfasından çağrılır. Stremio arayüzü (inject.js) yalnızca
    // indirme başlatma uçlarını ve okuma (GET) uçlarını çağırabilir.
    const origin = req.headers.origin
    const own = !origin || origin === cfg.base || origin === `http://localhost:${cfg.port}`
    const stremioOk = origin === STREMIO_ORIGIN && (parts[1] === 'download' || parts[1] === 'auto' || req.method === 'GET' || req.method === 'OPTIONS')
    if (!own && !stremioOk) return json(res, 403, { err: 'yasak' })
    if (origin === STREMIO_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Headers', 'content-type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
      if (req.method === 'OPTIONS') return res.writeHead(204).end()
    }
    // Temiz durdurma (durdur-servis.ps1): yalnızca servisin kendi sayfasından / kaynaksız yerel istekten (Stremio kökeni değil)
    if (parts[1] === 'kapat' && parts.length === 2) {
      if (req.method !== 'POST') return json(res, 405, { err: 'POST gerekli' })
      if (!own) return json(res, 403, { err: 'yasak' })
      json(res, 200, { ok: true })
      log('kapatma isteği alındı (/api/kapat)')
      setTimeout(() => shutdown(0), 100)
      return
    }
    if (parts[1] === 'klip' && parts.length <= 4) return klip.handle(req, res, parts) // klip uçları kendi yanıtını yazar (dosya sunumu)
    try {
      const [code, body] = await api.handle(req, parts, url)
      return json(res, code, body)
    } catch (e) {
      const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 500
      if (code >= 500) log('API hatası:', req.method, req.url, '-', e.message)
      return json(res, code, { err: e.message }, code === 413 ? { Connection: 'close' } : {})
    }
  }

  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { err: 'yöntem desteklenmiyor' })

  if (parts[0] === 'play' && parts.length === 5) {
    const [, type, id, infoHash, idxRaw] = parts
    if (!/^[a-f0-9]{40}$/i.test(infoHash)) return json(res, 400, { err: 'geçersiz infoHash' })
    try {
      return await servePlay(req, res, manager, { infoHash, fileIdx: /^\d+$/.test(idxRaw) ? +idxRaw : null, type, id: id === 'x' ? null : id, create: torrentio.isRecent(infoHash) })
    } catch (e) {
      log('oynatma hatası:', e.message)
      return json(res, e.status && e.status < 600 ? e.status : 502, { err: e.message })
    }
  }
  if (parts[0] === 'manifest') return json(res, 200, addon.manifest())
  if (parts[0] === 'stream' && parts.length === 3) return json(res, 200, await addon.streams(parts[1], parts[2]))
  if (parts[0] === 'catalog' && parts.length >= 3) return json(res, 200, addon.catalog(parts[1]))
  if (parts[0] === 'meta' && parts.length === 3) {
    const m = addon.metaFor(parts[1], parts[2])
    return m ? json(res, 200, m) : json(res, 404, { err: 'kütüphanede yok' })
  }
  if (parts[0] === 'img' && parts.length === 2 && /^tt\d+-(poster|background|logo)$/.test(parts[1])) {
    const f = path.join(cfg.imgDir, parts[1])
    if (!fs.existsSync(f)) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' })
    return fs.createReadStream(f).on('error', () => res.destroy()).pipe(res)
  }
  if (parts[0] === 'logo.svg') return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(addon.logo)
  // İndirme Merkezi (web/): kök sayfa + /ui/<dosya> varlıkları
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'index.html')) return serveWeb(res, 'index.html')
  if (parts[0] === 'ui' && parts.length === 2) return serveWeb(res, parts[1])
  json(res, 404, { err: 'yok' })
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    log('istek hatası:', req.url, '-', e.message)
    if (!res.headersSent) json(res, 502, { err: e.message })
    else res.destroy()
  })
})

server.on('error', async e => {
  if (e.code === 'EADDRINUSE') {
    // Yarış: iki örnek aynı anda başladı. Diğeri çalışıyorsa motora dokunmadan sessizce çık;
    // kapıyı başka bir uygulama tutuyorsa bunu açıkça yaz (yanıltıcı "servis zaten çalışıyor" yazma).
    const ours = await alreadyRunning(cfg) || (await new Promise(r => setTimeout(r, 700)), await alreadyRunning(cfg))
    if (ours) { log(`Port ${cfg.port} kullanımda — servis zaten çalışıyor, bu örnek çıkıyor.`); process.exit(0) }
    log(`Port ${cfg.port} başka bir uygulama tarafından kullanılıyor; servis başlatılamadı. config.json'daki "port" değerini değiştir.`)
    process.exit(1)
  }
  log('sunucu hatası: ' + e.message)
  shutdown(1)
})

let stopInjector = null
let stopKisayolBekci = null
server.listen(cfg.port, '127.0.0.1', () => {
  log(`Offline İndir çalışıyor → ${cfg.base}`)
  log(`İndirme klasörü: ${cfg.downloadDir}`)
  if (cfg.testMode) log('Sınama kipi: veri klasörü', cfg.dataDir)
  init()
  manager.start()
  // Önce eski süreçler (pid kaydından) kapatılır, sonra kontrol motoru ve inmekte olan öğelerin motorları başlar.
  pool.start().catch(e => log('motor başlatılamadı:', e.message))
  manager.startup()
  if (cfg.inject) stopInjector = startInjector(cfg)
  // Stremio güncellenince "Stremio" kısayolunu yine düğmeli başlatıcıya çevirir (sınama kipinde kapalı).
  try { stopKisayolBekci = startKisayolBekci(cfg) } catch (e) { log('kısayol bekçisi başlatılamadı:', e.message) }
})

let stopping = false
function shutdown (code = 0) {
  if (stopping) return
  stopping = true
  log('servis kapanıyor')
  try { stopInjector?.() } catch {}
  try { stopKisayolBekci?.() } catch {}
  try { klip?.stop() } catch {}
  try { manager.stop() } catch {}
  try { kapat.stop() } catch {}
  try { guncelleme.stop() } catch {}
  try { pool.stopAll() } catch {}
  try { server.close() } catch {}
  setTimeout(() => process.exit(code), 300)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
// Windows: konsol penceresi kapatılınca (SIGHUP) ya da Ctrl+Break (SIGBREAK) da temiz kapan;
// zorla öldürülürse rqbit süreçleri açık kalır ve bir sonraki açılışta pid dosyalarından kapatılır
// (data/rqbit/rqbit.pid, data/rqbit/motorlar/<yuva>/rqbit.pid).
process.on('SIGHUP', () => shutdown(0))
process.on('SIGBREAK', () => shutdown(0))
process.on('exit', () => { try { pool.stopAll() } catch {} })
// Sınama ve dış denetim için: stdin'den "kapat" satırı gelirse temiz kapanır.
if (process.env.OFFLINE_STDIN_CONTROL === '1') {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => { if (/kapat/.test(d)) shutdown(0) })
}
