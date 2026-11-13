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

export class Engine extends EventEmitter {
  constructor (cfg) {
    super()
    this.cfg = cfg
    this.base = `http://127.0.0.1:${cfg.rqbitApiPort}`
    this.proc = null
    this.ready = false
    this.stopped = false
    this.failures = 0
    this.restarts = 0
    this.lastError = null
    this.pidFile = path.join(cfg.rqbitDir, 'rqbit.pid')
  }

  args () {
    const c = this.cfg
    const a = ['--http-api-listen-addr', `127.0.0.1:${c.rqbitApiPort}`, '--listen-port', String(c.rqbitPeerPort),
      '--disable-upnp-port-forward', '--disable-dht-persistence', '--log-file', path.join(c.rqbitDir, 'rqbit.log')]
    if (c.peerListenIp) a.push('--listen-ip', c.peerListenIp)
    if (c.loopback) a.push('--disable-dht', '--disable-trackers', '--disable-lsd', '--ipv4-only')
    if (c.downloadLimit > 0) a.push('--ratelimit-download', String(Math.floor(c.downloadLimit)))
    a.push('server', 'start', '--persistence-location', path.join(c.rqbitDir, 'oturum'), c.downloadDir)
    return a
  }

  /** Önceki bir çalışmadan kalmış (servis çökmüş) rqbit sürecini kapatır. */
  killStale () {
    let pid
    try { pid = Number(fs.readFileSync(this.pidFile, 'utf8')) } catch { return }
    if (!pid) return
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      if (/rqbit\.exe/i.test(out)) {
        process.kill(pid)
        log('önceki çalışmadan kalan rqbit kapatıldı, pid', pid)
      }
    } catch {}
    try { fs.rmSync(this.pidFile, { force: true }) } catch {}
  }

  async portBusy () {
    try { await fetch(this.base + '/', { signal: AbortSignal.timeout(1000) }); return true } catch { return false }
  }

  rotateLogs () {
    for (const f of ['rqbit.log', 'rqbit.err']) {
      const p = path.join(this.cfg.rqbitDir, f)
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
    if (await this.portBusy()) throw new Error(`127.0.0.1:${this.cfg.rqbitApiPort} başka bir süreç tarafından kullanılıyor`)
    if (!fs.existsSync(this.cfg.rqbitExe)) throw new Error('rqbit bulunamadı: ' + this.cfg.rqbitExe)
    this.rotateLogs()
    const err = fs.openSync(path.join(this.cfg.rqbitDir, 'rqbit.err'), 'a')
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
    try { fs.writeFileSync(this.pidFile, String(p.pid)) } catch {}
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      if (exited) throw new Error('rqbit hemen kapandı; ayrıntı: ' + path.join(this.cfg.rqbitDir, 'rqbit.err'))
      try {
        const r = await fetch(this.base + '/', { signal: AbortSignal.timeout(1000) })
        if (r.ok) {
          this.ready = true
          this.failures = 0
          this.lastError = null
          log(`rqbit hazır (${Date.now() - t0} ms), API 127.0.0.1:${this.cfg.rqbitApiPort}`)
          this.emit('ready')
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
    if (this.proc) { try { this.proc.kill() } catch {} }
    this.proc = null
    try { fs.rmSync(this.pidFile, { force: true }) } catch {}
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
