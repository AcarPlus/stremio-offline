// rqbit motor bağdaştırıcısı: alt süreç olarak başlatır, sağlığını izler, düşerse yeniden
// başlatır; HTTP API'sine ince bir istemci sunar. API yalnızca 127.0.0.1'de dinler.
import { spawn, execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { log } from './log.mjs'

export class EngineError extends Error {
  constructor (message, status) { super(message); this.status = status }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** rqbit sınırı: nonzero u32 (bayt/sn). 0/boş = sınırsız (API'de null, bayrak verilmez). */
export const LIMIT_MAX = 4294967295
const limitValue = v => (v > 0 ? Math.min(LIMIT_MAX, Math.floor(v)) : null)

/** pid dosyası: {"pid","apiPort"} (eski sürüm yalnızca sayı yazar; o zaman kapı varsayılandır). */
export function readPidFile (file, defaultPort) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8').trim() } catch { return null }
  try {
    const j = JSON.parse(raw)
    if (typeof j === 'number') return j > 0 ? { pid: j, apiPort: defaultPort } : null
    if (j && Number(j.pid) > 0) return { pid: Number(j.pid), apiPort: Number(j.apiPort) || defaultPort }
  } catch {}
  return null
}

/**
 * Verilen {pid, apiPort} kayıtlarından hangileri bu servisin başlattığı rqbit? (tek PowerShell çağrısı)
 * Ölçüt: çalıştırılabilir yol bizim rqbitExe, komut satırında bizim API kapımız. Ada göre toplu eşleme yok.
 */
export function ownedPids (rqbitExe, entries) {
  entries = entries.filter(e => e && Number(e.pid) > 0)
  if (!entries.length) return []
  try {
    const filter = [...new Set(entries.map(e => Number(e.pid)))].map(p => `ProcessId=${p}`).join(' OR ')
    const ps = `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim()
    if (!out) return []
    let procs = JSON.parse(out)
    if (!Array.isArray(procs)) procs = [procs]
    const norm = x => path.resolve(String(x || '')).toLowerCase()
    return entries.filter(e => procs.some(p => Number(p.ProcessId) === Number(e.pid) &&
      norm(p.ExecutablePath) === norm(rqbitExe) &&
      String(p.CommandLine || '').includes(`--http-api-listen-addr 127.0.0.1:${e.apiPort}`)))
  } catch { return [] }
}

/** pid dosyalarındaki eski süreçleri kapatır (yalnız bizimkileri) ve dosyaları siler. */
export function killStalePidFiles (rqbitExe, files) {
  const entries = files.map(f => ({ file: f.file, ...(readPidFile(f.file, f.apiPort) || {}) }))
  const owned = ownedPids(rqbitExe, entries)
  for (const e of entries) {
    if (e.pid) {
      if (owned.includes(e)) {
        try { process.kill(e.pid); log('önceki çalışmadan kalan rqbit kapatıldı, pid', e.pid, 'kapı', e.apiPort) } catch {}
      } else log('pid dosyasındaki süreç bizim rqbit değil (ya da yok); dokunulmadı, pid', e.pid)
    }
    try { fs.rmSync(e.file, { force: true }) } catch {}
  }
  // Kapıları bırakmaları için kapanmalarını bekle (en çok ~3 sn); böylece aynı yuva yeniden kullanılabilir
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const t0 = Date.now()
  while (owned.some(e => alive(e.pid)) && Date.now() - t0 < 3000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  return owned.length
}

/**
 * opts (hepsi isteğe bağlı; verilmezse eski tek motor davranışı, cfg'den):
 *   name, apiPort, peerPort, dir (pid/günlük klasörü), limits: () => ({ down, up }) bayt/sn (0 = sınırsız)
 */
export class Engine extends EventEmitter {
  constructor (cfg, opts = {}) {
    super()
    this.cfg = cfg
    this.name = opts.name || 'rqbit'
    this.apiPort = opts.apiPort ?? cfg.rqbitApiPort
    this.peerPort = opts.peerPort ?? cfg.rqbitPeerPort
    this.dir = opts.dir || cfg.rqbitDir
    this.limits = opts.limits || (() => ({ down: cfg.downloadLimit || 0, up: 0 }))
    this.base = `http://127.0.0.1:${this.apiPort}`
    this.proc = null
    this.ready = false
    this.stopped = false
    this.failures = 0
    this.restarts = 0
    this.readyCount = 0
    this.lastError = null
    this.argLimits = null
    this.pidFile = path.join(this.dir, 'rqbit.pid')
  }

  get pid () { return this.proc?.pid ?? null }

  args () {
    const c = this.cfg
    const a = ['--http-api-listen-addr', `127.0.0.1:${this.apiPort}`, '--listen-port', String(this.peerPort),
      '--disable-upnp-port-forward', '--disable-dht-persistence', '--log-file', path.join(this.dir, 'rqbit.log')]
    if (c.peerListenIp) a.push('--listen-ip', c.peerListenIp)
    if (c.loopback) a.push('--disable-dht', '--disable-trackers', '--disable-lsd', '--ipv4-only')
    const { down, up } = this.limits()
    this.argLimits = { down: limitValue(down), up: limitValue(up) }
    if (this.argLimits.down) a.push('--ratelimit-download', String(this.argLimits.down))
    if (this.argLimits.up) a.push('--ratelimit-upload', String(this.argLimits.up))
    // Oturum kalıcılığı kapalı: torrentlerin doğruluk kaynağı servisin kütüphanesidir (library.json +
    // data/torrents/<infohash>.torrent); motor her başlatmada torrenti aynı klasöre yeniden ekler ve doğrular.
    a.push('server', 'start', '--disable-persistence', c.downloadDir)
    return a
  }

  /** Geçerli sınırları çalışan sürece uygular (POST /torrents/limits; yeniden başlatma yok). */
  async applyLimits () {
    const { down, up } = this.limits()
    const want = { down: limitValue(down), up: limitValue(up) }
    // Eksik alan "sınırsız" sayılır; her iki alan da her zaman gönderilir.
    await this.req('POST', '/torrents/limits', { body: JSON.stringify({ download_bps: want.down, upload_bps: want.up }), headers: { 'Content-Type': 'application/json' } })
    this.argLimits = want
    return want
  }

  /** İstenen sınır, motora en son verilenden farklı mı? */
  limitsChanged () {
    const { down, up } = this.limits()
    return limitValue(down) !== this.argLimits?.down || limitValue(up) !== this.argLimits?.up
  }

  /** Fark varsa uygular (aynı anda tek istek). */
  async syncLimits () {
    if (!this.ready || this.applying || !this.limitsChanged()) return false
    this.applying = true
    try { await this.applyLimits(); return true } finally { this.applying = false }
  }

  /** Şu an motorun uyguladığı sınırlar (bayt/sn, null = sınırsız). */
  async currentLimits () { return this.req('GET', '/torrents/limits') }

  /** pid, bu servisin başlattığı rqbit mi? (çalıştırılabilir yol bizim rqbitExe, komut satırı bizim API kapımız) */
  ownsPid (pid) {
    return ownedPids(this.cfg.rqbitExe, [{ pid, apiPort: this.apiPort }]).length === 1
  }

  /** Önceki bir çalışmadan kalmış (servis çökmüş) rqbit sürecini kapatır; yalnızca kendi başlattığımızı. */
  killStale () {
    if (!fs.existsSync(this.pidFile)) return
    killStalePidFiles(this.cfg.rqbitExe, [{ file: this.pidFile, apiPort: this.apiPort }])
  }

  async portBusy () {
    try { await fetch(this.base + '/', { signal: AbortSignal.timeout(1000) }); return true } catch { return false }
  }

  rotateLogs () {
    for (const f of ['rqbit.log', 'rqbit.err']) {
      const p = path.join(this.dir, f)
      try { if (fs.statSync(p).size > 20e6) fs.renameSync(p, p + '.old') } catch {}
    }
  }

  async start () {
    this.stopped = false
    this.killStale()
    this.healthTimer = setInterval(() => this.health().catch(() => {}), 3000)
    await this.spawnLoop()
  }

  async spawnLoop () {
    if (this.spawning) return
    this.spawning = true
    let delay = 1000
    try {
      while (!this.stopped) {
        try {
          await this.spawnOnce()
          return
        } catch (e) {
          this.lastError = e.message
          log('rqbit başlatılamadı:', e.message, `(${Math.round(delay / 1000)} sn sonra yeniden)`)
          await sleep(delay)
          delay = Math.min(delay * 2, 30000)
        }
      }
    } finally { this.spawning = false }
  }

  async spawnOnce () {
    if (await this.portBusy()) throw new Error(`127.0.0.1:${this.apiPort} başka bir süreç tarafından kullanılıyor`)
    if (!fs.existsSync(this.cfg.rqbitExe)) throw new Error('rqbit bulunamadı: ' + this.cfg.rqbitExe)
    fs.mkdirSync(this.dir, { recursive: true })
    this.rotateLogs()
    const err = fs.openSync(path.join(this.dir, 'rqbit.err'), 'a')
    const p = spawn(this.cfg.rqbitExe, this.args(), { stdio: ['ignore', 'ignore', err], windowsHide: true })
    fs.closeSync(err)
    this.proc = p
    let exited = false
    p.on('error', e => { exited = true; this.lastError = e.message })
    p.on('exit', code => {
      exited = true
      if (this.proc !== p) return
      this.proc = null
      const was = this.ready
      this.ready = false
      try { fs.rmSync(this.pidFile, { force: true }) } catch {}
      if (!this.stopped && was) {
        log('rqbit kapandı (kod ' + code + '); yeniden başlatılıyor')
        this.emit('down')
        this.restarts++
        setTimeout(() => this.spawnLoop(), 1000)
      }
    })
    try { fs.writeFileSync(this.pidFile, JSON.stringify({ pid: p.pid, apiPort: this.apiPort })) } catch {}
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      if (exited) throw new Error('rqbit hemen kapandı; ayrıntı: ' + path.join(this.dir, 'rqbit.err'))
      if (this.stopped || this.proc !== p) throw new Error('durduruldu')
      try {
        const r = await fetch(this.base + '/', { signal: AbortSignal.timeout(1000) })
        if (r.ok) {
          this.ready = true
          this.failures = 0
          this.lastError = null
          this.readyCount++
          log(`rqbit hazır (${Date.now() - t0} ms), ${this.name}, API 127.0.0.1:${this.apiPort}, pid ${p.pid}`)
          // Başlatma bayrağından sonra sınır değiştiyse (başlarken gelen istek) şimdi uygula
          const { down, up } = this.limits()
          if (limitValue(down) !== this.argLimits?.down || limitValue(up) !== this.argLimits?.up) {
            this.applyLimits().catch(e => log('sınır uygulanamadı:', this.name, e.message))
          }
          this.emit('ready', this.readyCount)
          return
        }
      } catch {}
      await sleep(150)
    }
    this.proc = null
    try { p.kill() } catch {}
    throw new Error('rqbit 20 sn içinde yanıt vermedi')
  }

  async health () {
    if (!this.proc || !this.ready || this.stopped) return
    try {
      const r = await fetch(this.base + '/', { signal: AbortSignal.timeout(4000) })
      if (!r.ok) throw new Error('durum ' + r.status)
      this.failures = 0
    } catch (e) {
      this.failures++
      if (this.failures >= 3 && this.proc) {
        log('rqbit yanıt vermiyor (' + e.message + '); yeniden başlatılıyor')
        this.failures = 0
        try { this.proc.kill() } catch {} // 'exit' olayı yeniden başlatır
      }
    }
  }

  async whenReady (ms = 30000) {
    const t0 = Date.now()
    while (!this.ready) {
      if (this.stopped || Date.now() - t0 > ms) throw new EngineError('İndirme motoru (rqbit) hazır değil' + (this.lastError ? ': ' + this.lastError : ''), 503)
      await sleep(200)
    }
  }

  stop () {
    this.stopped = true
    clearInterval(this.healthTimer)
    this.ready = false
    // Hiç başlamamış örnek (ör. ikinci servis örneği) çalışan örneğin pid dosyasına dokunmaz.
    if (this.proc) {
      try { this.proc.kill() } catch {}
      try { fs.rmSync(this.pidFile, { force: true }) } catch {}
    }
    this.proc = null
  }

  // ------------------------------------------------------------ API istemcisi

  async req (method, p, { body, query, signal, timeoutMs = 15000, raw = false, headers } = {}) {
    await this.whenReady()
    const qs = query ? '?' + Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : ''
    const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean)
    let r
    try {
      r = await fetch(this.base + p + qs, { method, body, headers, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] })
    } catch (e) {
      if (e.name === 'TimeoutError') throw new EngineError('rqbit zaman aşımı: ' + method + ' ' + p, 504)
      if (e.name === 'AbortError') throw e
      throw new EngineError('rqbit bağlantı hatası: ' + e.message, 503)
    }
    const buf = Buffer.from(await r.arrayBuffer())
    if (!r.ok) {
      let msg = buf.toString('utf8')
      try { msg = JSON.parse(msg).human_readable || msg } catch {}
      throw new EngineError(msg, r.status)
    }
    if (raw) return buf
    try { return JSON.parse(buf.toString('utf8') || '{}') } catch { return {} }
  }

  /** source: magnet metni ya da .torrent baytları. Metadata gelene dek bekler (signal ile kesilir). */
  add (source, { onlyFiles, outputFolder, listOnly, signal } = {}) {
    const query = { overwrite: 'true' }
    if (onlyFiles?.length) query.only_files = onlyFiles.join(',')
    if (outputFolder) query.output_folder = outputFolder
    if (listOnly) query.list_only = 'true'
    if (this.cfg.extraPeers.length) query.initial_peers = this.cfg.extraPeers.join(',')
    return this.req('POST', '/torrents', { body: source, query, signal, timeoutMs: 0 })
  }

  list () { return this.req('GET', '/torrents') }
  details (ih) { return this.req('GET', `/torrents/${ih}`) }
  stats (ih) { return this.req('GET', `/torrents/${ih}/stats/v1`) }
  metadata (ih) { return this.req('GET', `/torrents/${ih}/metadata`, { raw: true }) }
  forget (ih) { return this.req('POST', `/torrents/${ih}/forget`) }
  delete (ih) { return this.req('POST', `/torrents/${ih}/delete`, { timeoutMs: 60000 }) }
  updateOnlyFiles (ih, files) { return this.req('POST', `/torrents/${ih}/update_only_files`, { body: JSON.stringify({ only_files: files }), headers: { 'Content-Type': 'application/json' } }) }

  async pause (ih) {
    try { await this.req('POST', `/torrents/${ih}/pause`) } catch (e) { if (!/already paused/i.test(e.message)) throw e }
  }

  async resume (ih) {
    try { await this.req('POST', `/torrents/${ih}/start`) } catch (e) { if (!/already live/i.test(e.message)) throw e }
    await this.addExtraPeers(ih)
  }

  async addExtraPeers (ih) {
    if (!this.cfg.extraPeers.length) return
    try { await this.req('POST', `/torrents/${ih}/add_peers`, { body: this.cfg.extraPeers.join('\n') + '\n' }) } catch {}
  }

  async has (ih) {
    try { await this.stats(ih); return true } catch (e) { if (e.status === 404) return false; throw e }
  }

  streamUrl (ih, idx) { return `${this.base}/torrents/${ih}/stream/${idx}` }
}
