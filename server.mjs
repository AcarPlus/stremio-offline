// Stremio "Offline İndir" — yerel eklenti + indirme servisi (motor: rqbit).
// Modüller: lib/engine (rqbit alt süreci), lib/manager (indirme yöneticisi), lib/torrentio,
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
import { Engine } from './lib/engine.mjs'
import { Library } from './lib/library.mjs'
import { MetaStore } from './lib/meta.mjs'
import { Manager } from './lib/manager.mjs'
import { Torrentio } from './lib/torrentio.mjs'
import { Addon } from './lib/addon.mjs'
import { Api } from './lib/api.mjs'
import { servePlay } from './lib/play.mjs'
import { startInjector } from './lib/inject.mjs'

// Yakalanmamış hata servisi kapatmaz: günlüğe yazılır, servis sürer.
process.on('uncaughtException', e => log('yakalanmamış hata:', e))
process.on('unhandledRejection', e => log('yakalanmamış ret:', e))

const cfg = loadConfig()
setLogFile(path.join(cfg.dataDir, 'servis.log'))
const engine = new Engine(cfg)
const library = new Library(cfg.libFile).load()
const meta = new MetaStore(cfg)
const manager = new Manager({ cfg, engine, library, meta })
const torrentio = new Torrentio(cfg, meta)
const addon = new Addon({ cfg, manager, torrentio, meta })
const api = new Api({ cfg, manager, torrentio })

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
    try {
      const [code, body] = await api.handle(req, parts, url)
      return json(res, code, body)
    } catch (e) {
      const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 500
      if (code >= 500) log('API hatası:', req.method, req.url, '-', e.message)
      return json(res, code, { err: e.message })
    }
  }

  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { err: 'yöntem desteklenmiyor' })

  if (parts[0] === 'play' && parts.length === 5) {
    const [, type, id, infoHash, idxRaw] = parts
    if (!/^[a-f0-9]{40}$/i.test(infoHash)) return json(res, 400, { err: 'geçersiz infoHash' })
    try {
      return await servePlay(req, res, manager, { infoHash, fileIdx: /^\d+$/.test(idxRaw) ? +idxRaw : null, type, id: id === 'x' ? null : id })
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

server.on('error', e => {
  log(e.code === 'EADDRINUSE' ? `Port ${cfg.port} kullanımda — servis zaten çalışıyor olabilir.` : 'sunucu hatası: ' + e.message)
  shutdown(1)
})

let stopInjector = null
server.listen(cfg.port, '127.0.0.1', () => {
  log(`Offline İndir çalışıyor → ${cfg.base}`)
  log(`İndirme klasörü: ${cfg.downloadDir}`)
  if (cfg.testMode) log('Sınama kipi: veri klasörü', cfg.dataDir)
  manager.start()
  engine.start().catch(e => log('motor başlatılamadı:', e.message))
  if (cfg.inject) stopInjector = startInjector(cfg)
})

let stopping = false
function shutdown (code = 0) {
  if (stopping) return
  stopping = true
  log('servis kapanıyor')
  try { stopInjector?.() } catch {}
  try { manager.stop() } catch {}
  try { engine.stop() } catch {}
  try { server.close() } catch {}
  setTimeout(() => process.exit(code), 300)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
// Windows: konsol penceresi kapatılınca (SIGHUP) ya da Ctrl+Break (SIGBREAK) da temiz kapan;
// zorla öldürülürse rqbit açık kalır ve bir sonraki açılışta kapatılır (data/rqbit/rqbit.pid).
process.on('SIGHUP', () => shutdown(0))
process.on('SIGBREAK', () => shutdown(0))
process.on('exit', () => { try { engine.stop() } catch {} })
// Sınama ve dış denetim için: stdin'den "kapat" satırı gelirse temiz kapanır.
if (process.env.OFFLINE_STDIN_CONTROL === '1') {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => { if (/kapat/.test(d)) shutdown(0) })
}
