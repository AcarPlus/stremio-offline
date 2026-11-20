// Klip: indirmeden önce bir kaynağın görüntü kalitesini görmek için 60 sn'lik örnek.
//
//   1. Torrent GEÇİCİ olarak motor havuzunda (lib/pool.mjs) kendi rqbit sürecinde başlatılır; anahtar
//      "klip:<infoHash>" (kütüphaneye/İndirilenler'e eklenmez, kalıcı kayıt yok). Yalnız seçilen dosya
//      (only_files) data/klipler/gecici/<iş> klasörüne iner. İndirme sınırı yok; yükleme sınırı ayarı
//      havuzun sınır sorgusuyla (Manager.limitsFor: kütüphanede olmayan anahtar -> { down: 0, up: uploadLimit }) uygulanır.
//      Dosya kütüphanede zaten tamamsa motor açılmaz, diskteki dosyadan kesilir.
//   2. ffprobe rqbit akış adresinden (HTTP Range) süreyi ve akışları okur; ffmpeg %30 noktasına girdi öncesi
//      -ss ile atlar, -t 60, -c copy (yeniden sıkıştırma yok): ilk video + ilk ses + metin/görüntü altyazıları -> .mkv.
//      rqbit, ffmpeg'in istediği bölgeyi (MKV Cues / MP4 moov sonda olsa da) öne alır.
//   3. Bitince (başarılı ya da değil) geçici motor kapatılır, geçici parçalar silinir. Klip 24 saat tutulur;
//      servis açılışında ve saatlik temizlikte, ya da aynı içerik indirilip tamamlanınca silinir.
//   Aynı anda tek klip işi. ffmpeg/ffprobe: Stremio'nun kurulum klasöründekiler (OFFLINE_FFMPEG ile değişir).
import { spawn, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseTorrent, withTrackers } from './bencode.mjs'
import { parseStremioId } from './library.mjs'
import { log } from './log.mjs'
import { parseRange } from './play.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isHash = s => /^[a-f0-9]{40}$/.test(s)
const num = v => (v === undefined || v === '' ? undefined : Number(v))
const FINAL = new Set(['ready', 'error', 'canceled'])
const CLIP_SEC = 60
const START_FRACTION = 0.3
// .mkv'ye kopyalanabilen altyazılar; mov_text (MP4) srt'ye çevrilir (metin, görüntü kalitesine etkisi yok); diğerleri atlanır.
const SUB_COPY = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'])
const SUB_TO_SRT = new Set(['mov_text', 'text'])
export const NO_PEERS = 'Bu kaynağın eşi yok ya da yanıt vermiyor; klip alınamadı.'

class KlipError extends Error {
  constructor (message, status = 400, extra) { super(message); this.status = status; this.extra = extra }
}

/**
 * ffmpeg/ffprobe yolu. OFFLINE_FFMPEG verilirse YALNIZ o kullanılır (ffmpeg.exe yolu ya da klasör).
 * Yoksa Stremio'nun kaldırma kaydındaki InstallLocation (HKCU Uninstall, DisplayName "Stremio…"), sonra
 * varsayılan %LOCALAPPDATA%\Programs\Stremio. ffprobe aynı klasörde aranır (paylaşımlı DLL'ler orada).
 * Dönüş: { available, ffmpeg, ffprobe, from, reason }
 */
export async function findFfmpeg (env = process.env) {
  const check = (dir, from) => {
    const ffmpeg = path.join(dir, 'ffmpeg.exe')
    const ffprobe = path.join(dir, 'ffprobe.exe')
    if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) return { available: true, ffmpeg, ffprobe, from, reason: null }
    return null
  }
  if (env.OFFLINE_FFMPEG) {
    const p = path.resolve(env.OFFLINE_FFMPEG)
    const dir = /\.exe$/i.test(p) ? path.dirname(p) : p
    return check(dir, 'OFFLINE_FFMPEG') || { available: false, from: 'OFFLINE_FFMPEG', reason: 'OFFLINE_FFMPEG ile verilen klasörde ffmpeg.exe/ffprobe.exe bulunamadı' }
  }
  const dirs = []
  if (process.platform === 'win32') {
    const reg = await stremioInstallDirs().catch(() => [])
    for (const d of reg) dirs.push([d, 'kayıt'])
  }
  if (env.LOCALAPPDATA) dirs.push([path.join(env.LOCALAPPDATA, 'Programs', 'Stremio'), 'varsayılan'])
  for (const [d, from] of dirs) { const r = check(d, from); if (r) return r }
  return { available: false, from: null, reason: 'Stremio’nun ffmpeg’i bulunamadı (Stremio 5 kurulu mu?). OFFLINE_FFMPEG ortam değişkeniyle yol verilebilir.' }
}

/** Kaldırma kaydından Stremio kurulum klasörleri (yalnız okuma). */
function stremioInstallDirs () {
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Stremio*' -and $_.InstallLocation } | ForEach-Object { $_.InstallLocation }"
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err) return resolve([])
      resolve(String(out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))
    })
  })
}

/** ffprobe çıktısından kesilecek akışlar: ilk video (kapak resmi değil), ilk ses, altyazılar. Saf. */
export function pickStreams (probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : []
  const video = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) || null
  const audio = streams.find(s => s.codec_type === 'audio') || null
  const subs = streams.filter(s => s.codec_type === 'subtitle' && (SUB_COPY.has(s.codec_name) || SUB_TO_SRT.has(s.codec_name)))
  const d = Number(probe?.format?.duration)
  return { video, audio, subs, duration: Number.isFinite(d) && d > 0 ? d : null }
}

/** Kesim noktası: sürenin %30'u, en çok 60 sn (kısa dosyada kalan kadar). Süre bilinmiyorsa baştan. Saf. */
export function clipWindow (duration) {
  if (!(duration > 0)) return { start: 0, length: CLIP_SEC }
  const start = Math.floor(duration * START_FRACTION)
  return { start, length: Math.max(1, Math.min(CLIP_SEC, Math.floor(duration - start))) }
}

/** ffmpeg kesim argümanları (girdi öncesi -ss, -c copy, -map ile seçili akışlar, .mkv). Saf. */
export function cutArgs ({ input, out, start, length, picks, withSubs = true, http = false }) {
  const a = ['-v', 'error', '-nostdin', '-y']
  if (http) a.push('-rw_timeout', '60000000') // akış 60 sn veri vermezse bırak (µs)
  a.push('-ss', String(start), '-i', input, '-t', String(length), '-map', '0:' + picks.video.index)
  if (picks.audio) a.push('-map', '0:' + picks.audio.index)
  const subs = withSubs ? picks.subs : []
  for (const s of subs) a.push('-map', '0:' + s.index)
  if (withSubs) a.push('-map', '0:t?') // ASS yazı tipleri (ek dosyalar)
  a.push('-c', 'copy')
  subs.forEach((s, k) => { if (SUB_TO_SRT.has(s.codec_name)) a.push(`-c:s:${k}`, 'srt') })
  a.push('-max_muxing_queue_size', '4096', '-progress', 'pipe:1', '-nostats', '-f', 'matroska', out)
  return a
}

export class Klip {
  constructor ({ cfg, manager, torrentio = null, env = process.env }) {
    this.cfg = cfg
    this.manager = manager
    this.torrentio = torrentio
    this.env = env
    this.dir = path.join(cfg.dataDir, 'klipler')
    this.tmpRoot = path.join(this.dir, 'gecici')
    this.timeoutMs = num(env.OFFLINE_KLIP_TIMEOUT_MS) || 180000
    this.ttlMs = num(env.OFFLINE_KLIP_TTL_MS) || 24 * 3600 * 1000
    this.job = null // son/çalışan iş
    this.recent = new Map() // id -> iş (son 20; iptal/hata durumu sorgulanabilsin)
    this.children = new Set()
    this.ff = null // findFfmpeg sonucu (önbellek)
    this.timers = []
  }

  start () {
    fs.mkdirSync(this.tmpRoot, { recursive: true })
    this.cleanup().catch(e => log('klip temizliği:', e.message))
    this.capability().catch(() => {})
    const t1 = setInterval(() => this.cleanup().catch(e => log('klip temizliği:', e.message)), 3600 * 1000)
    const t2 = setInterval(() => this.dropDownloaded().catch(() => {}), 60 * 1000)
    for (const t of [t1, t2]) { t.unref?.(); this.timers.push(t) }
    this.onExit = () => this.killChildren()
    process.on('exit', this.onExit)
    return this
  }

  stop () {
    for (const t of this.timers) clearInterval(t)
    if (this.job && !FINAL.has(this.job.state)) this.job.ac.abort(new KlipError('servis kapanıyor'))
    this.killChildren()
    if (this.onExit) process.off('exit', this.onExit)
  }

  killChildren () { for (const p of this.children) { try { p.kill() } catch {} } }

  async capability (refresh = false) {
    if (!this.ff || refresh || !this.ff.available) this.ff = await findFfmpeg(this.env)
    return this.ff
  }

  // ------------------------------------------------------------ kayıtlar (data/klipler/<id>.mkv + <id>.json)

  file (id) { return path.join(this.dir, id + '.mkv') }
  metaFile (id) { return path.join(this.dir, id + '.json') }
  readMeta (id) { try { return JSON.parse(fs.readFileSync(this.metaFile(id), 'utf8')) } catch { return null } }
  allMeta () {
    let names = []
    try { names = fs.readdirSync(this.dir) } catch {}
    return names.filter(n => /^[a-f0-9]{16}\.json$/.test(n)).map(n => this.readMeta(n.slice(0, -5))).filter(Boolean)
  }

  async removeKlip (id, why) {
    await fsp.rm(this.file(id), { force: true }).catch(() => {})
    await fsp.rm(this.metaFile(id), { force: true }).catch(() => {})
    if (this.job?.id === id && this.job.state === 'ready') this.job = null
    log('klip silindi:', id, why ? '(' + why + ')' : '')
  }

  /** Aynı içerik (aynı torrent ya da aynı film/bölüm) kütüphanede tamamlanmış mı? */
  contentDownloaded (m) {
    for (const i of this.manager.lib.all()) {
      if (i.infoHash === m.infoHash && i.state === 'completed') return true
      for (const f of i.files || []) {
        if (!f.selected || !(f.length > 0 && f.progressBytes >= f.length)) continue
        if (m.videoId && f.videoId === m.videoId) return true
      }
    }
    return false
  }

  async dropDownloaded () {
    for (const m of this.allMeta()) if (this.contentDownloaded(m)) await this.removeKlip(m.id, 'içerik indirildi')
  }

  /** Açılışta ve saatte bir: süresi dolan klipler, yarım çıktılar, sahipsiz dosyalar ve geçici parçalar. */
  async cleanup () {
    const now = Date.now()
    const running = this.job && !FINAL.has(this.job.state) ? this.job.id : null
    let names = []
    try { names = await fsp.readdir(this.dir) } catch { return }
    const metas = new Map(this.allMeta().map(m => [m.id, m]))
    for (const n of names) {
      const full = path.join(this.dir, n)
      if (n === 'gecici') continue
      const id = n.slice(0, 16)
      if (id === running) continue
      const m = metas.get(id)
      if (!m || now - (m.createdAt || 0) > this.ttlMs || !/\.(mkv|json)$/.test(n)) await fsp.rm(full, { force: true, recursive: true }).catch(() => {})
    }
    let tmps = []
    try { tmps = await fsp.readdir(this.tmpRoot) } catch {}
    for (const t of tmps) if (t !== running) await fsp.rm(path.join(this.tmpRoot, t), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    await this.dropDownloaded()
  }

  // ------------------------------------------------------------ görünüm

  fileUrl (id) { return `${this.cfg.base}/api/klip/${id}/dosya` }

  view (j) {
    if (!j) return null
    const ready = j.state === 'ready'
    return {
      id: j.id,
      state: j.state, // connecting | downloading | preparing | ready | error | canceled
      message: j.message || '',
      error: j.error || null,
      infoHash: j.infoHash,
      fileIdx: j.fileIdx ?? null,
      type: j.type || null,
      videoId: j.videoId || null,
      title: j.title || '',
      fileName: j.fileName || '',
      source: j.source || null, // torrent | disk
      downloadedBytes: j.downloadedBytes || 0,
      peers: j.peers || 0,
      durationSec: j.durationSec ?? null, // kaynağın süresi
      startSec: j.startSec ?? null, // klibin kaynakta başladığı yer
      lengthSec: j.lengthSec ?? null, // hedeflenen klip süresi
      doneSec: j.doneSec || 0, // yazılan
      sizeBytes: j.sizeBytes || 0,
      startedAt: j.startedAt || null,
      createdAt: j.createdAt || null,
      expiresAt: ready && j.createdAt ? j.createdAt + this.ttlMs : null,
      fileUrl: ready ? this.fileUrl(j.id) : null
    }
  }

  get (id) {
    if (this.job?.id === id) return this.job
    if (this.recent.has(id) && this.recent.get(id).state !== 'ready') return this.recent.get(id)
    const m = /^[a-f0-9]{16}$/.test(id) ? this.readMeta(id) : null
    if (m && fs.existsSync(this.file(id))) return { ...m, state: 'ready' }
    throw new KlipError('Böyle bir klip yok', 404)
  }

  // ------------------------------------------------------------ iş

  /** body: { infoHash, fileIdx, trackers, type, id (Stremio kimliği), title, fileName, replace } */
  async create (body) {
    const ff = await this.capability()
    if (!ff.available) throw new KlipError('Klip kullanılamıyor: ' + ff.reason, 503)
    const ih = String(body.infoHash || '').toLowerCase()
    if (!isHash(ih)) throw new KlipError('Geçersiz infoHash')
    const fileIdx = Number.isInteger(body.fileIdx) && body.fileIdx >= 0 ? body.fileIdx : null
    const sid = typeof body.id === 'string' && /^tt\d+(:\d+:\d+)?$/.test(body.id) ? body.id : null
    const key = ih + ':' + (fileIdx ?? 'x')
    // Aynı kaynağın hazır klibi varsa onu ver
    const have = this.allMeta().find(m => m.key === key && fs.existsSync(this.file(m.id)))
    if (have) return { existed: true, job: this.view({ ...have, state: 'ready' }) }
    const cur = this.job
    if (cur && !FINAL.has(cur.state)) {
      if (cur.key === key) return { existed: true, job: this.view(cur) }
      if (body.replace !== true) throw new KlipError('Başka bir klip hazırlanıyor; önce onu iptal et', 409, { job: this.view(cur) })
      await this.cancel(cur.id)
      // İptali beklerken başka bir istek yeni iş başlatmış olabilir: aynı anda iki iş doğmasın
      const simdi = this.job
      if (simdi && simdi !== cur && !FINAL.has(simdi.state)) throw new KlipError('Başka bir klip hazırlanıyor; önce onu iptal et', 409, { job: this.view(simdi) })
    }
    const known = this.torrentio?.lookup?.(ih)
    const trackers = [...new Set([...(Array.isArray(body.trackers) ? body.trackers : []), ...(known?.trackers || [])])]
      .filter(t => typeof t === 'string' && /^(udp|https?|wss?):\/\//.test(t))
    const { imdbId } = parseStremioId(sid || '')
    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      key,
      infoHash: ih,
      fileIdx,
      trackers,
      type: ['movie', 'series'].includes(body.type) ? body.type : null,
      videoId: sid,
      imdbId: imdbId || null,
      title: String(body.title || known?.name || '').split('\n')[0].slice(0, 200),
      fileName: String(body.fileName || '').slice(0, 200),
      state: 'connecting',
      message: 'Kaynağa bağlanılıyor…',
      startedAt: Date.now(),
      ac: new AbortController()
    }
    this.job = job
    this.recent.set(job.id, job)
    if (this.recent.size > 20) this.recent.delete(this.recent.keys().next().value)
    job.done = this.run(job)
    log('klip başladı:', job.id, job.title || ih)
    return { existed: false, job: this.view(job) }
  }

  async cancel (id) {
    const j = this.job?.id === id ? this.job : this.recent.get(id) || null
    if (j && !FINAL.has(j.state)) {
      j.ac.abort(new KlipError('İptal edildi'))
      await j.done?.catch(() => {})
      return true
    }
    this.get(id) // yoksa 404
    await this.removeKlip(id, 'kullanıcı sildi')
    return true
  }

  /** Alt süreç: çıktıyı toplar; sinyal gelirse öldürür. */
  exec (exe, args, { signal, onLine } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.children.add(p)
      let out = ''; let err = ''; let buf = ''
      p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
      p.stdout.on('data', d => {
        if (out.length < 4e6) out += d
        if (!onLine) return
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1) }
      })
      p.stderr.on('data', d => { if (err.length < 64e3) err += d })
      const kill = () => { try { p.kill() } catch {} }
      signal?.addEventListener('abort', kill, { once: true })
      p.on('error', e => { this.children.delete(p); signal?.removeEventListener('abort', kill); reject(e) })
      p.on('close', code => {
        this.children.delete(p)
        signal?.removeEventListener('abort', kill)
        if (signal?.aborted) return reject(signal.reason)
        resolve({ code, out, err })
      })
    })
  }

  async run (job) {
    const ff = this.ff
    const M = this.manager
    const ih = job.infoHash
    const timer = setTimeout(() => job.ac.abort(new KlipError('zaman aşımı', 504)), this.timeoutMs)
    const signal = job.ac.signal
    let engineKey = null
    let statsTimer = null
    let readStats = null
    const tmp = path.join(this.tmpRoot, job.id)
    const part = path.join(this.dir, job.id + '.part')
    try {
      let input
      const item = M.lib.get(ih)
      const f = item && M.pickFile(item, job.fileIdx, job.videoId)
      if (f && M.fileOnDisk(f)) {
        input = f.path
        job.source = 'disk'
        job.fileName = job.fileName || f.name
      } else {
        job.source = 'torrent'
        engineKey = 'klip:' + ih
        // Kütüphanede olmayan anahtar: havuz onu ayrı süreçte çalıştırır, Manager.limitsFor indirme sınırsız + yükleme sınırı verir.
        const eng = await M.pool.ensure({ infoHash: engineKey, name: 'klip ' + (job.title || ih) })
        await eng.whenReady(30000)
        if (signal.aborted) throw signal.reason
        await fsp.mkdir(tmp, { recursive: true })
        const cached = M.readCachedTorrent(ih)
        const source = cached ? withTrackers(cached, job.trackers) : M.magnet({ infoHash: ih, trackers: job.trackers })
        const metaSignal = AbortSignal.any([signal, AbortSignal.timeout(this.cfg.metadataTimeoutSec * 1000)])
        let idx = job.fileIdx
        let res
        try {
          if (idx == null) {
            const files = cached ? parseTorrent(cached).files
              : ((await eng.add(source, { listOnly: true, signal: metaSignal })).details?.files || []).map((x, i) => ({ idx: i, name: x.name, components: x.components, length: x.length }))
            idx = M.defaultFiles(files, { name: '' }, job.videoId)[0]
            if (idx == null) throw new KlipError('Torrentte video dosyası yok', 404)
            job.fileIdx = idx
          }
          res = await eng.add(source, { onlyFiles: [idx], outputFolder: tmp, signal: metaSignal })
        } catch (e) {
          if (signal.aborted) throw signal.reason
          if (e instanceof KlipError) throw e
          log('klip: torrent eklenemedi:', e.message)
          if (metaSignal.aborted || e.name === 'TimeoutError' || e.name === 'AbortError') throw new KlipError(NO_PEERS + ' (torrent bilgisi alınamadı)', 504)
          throw new KlipError(NO_PEERS + ' (' + e.message + ')', 502)
        }
        const fd = res?.details?.files?.[idx]
        if (fd) job.fileName = job.fileName || (fd.components || [fd.name]).slice(-1)[0]
        await eng.addExtraPeers(ih)
        input = eng.streamUrl(ih, idx)
        job.state = 'downloading'
        job.message = 'İndiriliyor…'
        readStats = async () => {
          try {
            const st = await eng.stats(ih)
            job.downloadedBytes = Math.max(job.downloadedBytes || 0, st.progress_bytes || 0)
            job.peers = st.live?.snapshot?.peer_stats?.live ?? 0
          } catch {}
        }
        statsTimer = setInterval(readStats, 1000)
      }

      // Süre ve akışlar
      const http = /^https?:/.test(input)
      const pr = await this.exec(ff.ffprobe, ['-v', 'error', ...(http ? ['-rw_timeout', '60000000'] : []),
        '-show_entries', 'format=duration:stream=index,codec_type,codec_name:stream_disposition=attached_pic', '-of', 'json', input], { signal })
      let probe = null
      try { probe = JSON.parse(pr.out) } catch {}
      if (pr.code !== 0 || !probe) throw new KlipError('Dosya okunamadı: ' + (firstLine(pr.err) || 'ffprobe ' + pr.code), 502)
      const picks = pickStreams(probe)
      if (!picks.video) throw new KlipError('Dosyada video akışı yok', 422)
      const win = clipWindow(picks.duration)
      job.durationSec = picks.duration
      job.startSec = win.start
      job.lengthSec = win.length
      job.state = 'preparing'
      job.message = 'Klip hazırlanıyor…'

      const onLine = l => {
        const m = /^out_time_(us|ms)=(\d+)/.exec(l)
        if (m) job.doneSec = Math.min(win.length, Math.round(+m[2] / 1e6))
      }
      let r = await this.exec(ff.ffmpeg, cutArgs({ input, out: part, start: win.start, length: win.length, picks, http }), { signal, onLine })
      if (r.code !== 0 && picks.subs.length) {
        log('klip: altyazılarla kesilemedi, altyazısız yeniden deneniyor:', firstLine(r.err))
        r = await this.exec(ff.ffmpeg, cutArgs({ input, out: part, start: win.start, length: win.length, picks, http, withSubs: false }), { signal, onLine })
      }
      if (r.code !== 0) {
        const msg = firstLine(r.err)
        if (readStats) await readStats()
        throw new KlipError(job.source === 'torrent' && !job.downloadedBytes ? NO_PEERS : 'Klip alınamadı: ' + (msg || 'ffmpeg ' + r.code), 502)
      }
      if (readStats) await readStats() // son durum (kısa işte zamanlayıcı hiç çalışmamış olabilir)
      const size = fs.statSync(part).size
      if (!size) throw new KlipError('Klip boş çıktı', 502)
      await fsp.rename(part, this.file(job.id))
      job.sizeBytes = size
      job.doneSec = win.length
      job.createdAt = Date.now()
      const meta = {
        id: job.id, key: job.key, infoHash: ih, fileIdx: job.fileIdx, type: job.type, videoId: job.videoId, imdbId: job.imdbId,
        title: job.title, fileName: job.fileName, source: job.source, durationSec: job.durationSec, startSec: job.startSec,
        lengthSec: job.lengthSec, sizeBytes: size, downloadedBytes: job.downloadedBytes || 0, createdAt: job.createdAt
      }
      await fsp.writeFile(this.metaFile(job.id), JSON.stringify(meta))
      job.state = 'ready'
      job.message = 'Klip hazır'
      log('klip hazır:', job.id, size, 'bayt')
    } catch (e) {
      const reason = signal.aborted ? signal.reason : e
      if (signal.aborted && reason?.status !== 504) {
        job.state = 'canceled'
        job.message = 'İptal edildi'
        job.error = null
      } else {
        job.state = 'error'
        job.error = reason?.status === 504 && reason.message === 'zaman aşımı'
          ? (job.source === 'torrent' && !job.downloadedBytes ? NO_PEERS : `Klip ${Math.round(this.timeoutMs / 60000)} dk içinde hazırlanamadı (kaynak çok yavaş).`)
          : (reason?.message || String(reason))
        job.message = job.error
      }
      log('klip bitmedi:', job.id, job.state, job.error || '')
      await fsp.rm(part, { force: true }).catch(() => {})
    } finally {
      clearTimeout(timer)
      clearInterval(statsTimer)
      job.finishedAt = Date.now()
      if (engineKey) {
        const eng = M.pool.get(engineKey)
        const pid = eng?.pid
        M.pool.stop(engineKey)
        const t0 = Date.now()
        while (pid && alive(pid) && Date.now() - t0 < 5000) await sleep(100)
        await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(e => log('klip geçici klasörü silinemedi:', e.message))
      }
    }
  }

  // ------------------------------------------------------------ HTTP: /api/klip...

  async handle (req, res, parts) {
    const [, , id, sub] = parts
    const m = req.method
    try {
      if (!id) {
        if (m === 'GET') {
          const ff = await this.capability()
          await this.dropDownloaded().catch(() => {})
          return send(res, 200, {
            available: ff.available, reason: ff.reason || null, ffmpegFrom: ff.from || null,
            job: this.job && !FINAL.has(this.job.state) ? this.view(this.job) : null,
            klips: this.allMeta().filter(x => fs.existsSync(this.file(x.id))).sort((a, b) => b.createdAt - a.createdAt).map(x => this.view({ ...x, state: 'ready' }))
          })
        }
        if (m === 'POST') {
          const body = await readJson(req)
          const r = await this.create(body)
          return send(res, r.existed ? 200 : 201, r)
        }
        return send(res, 405, { err: 'yöntem desteklenmiyor' })
      }
      if (!/^[a-f0-9]{16}$/.test(id)) return send(res, 404, { err: 'Böyle bir klip yok' })
      if (!sub) {
        if (m === 'GET') return send(res, 200, this.view(this.get(id)))
        if (m === 'DELETE') return send(res, 200, { ok: await this.cancel(id) })
        return send(res, 405, { err: 'yöntem desteklenmiyor' })
      }
      if (sub === 'dosya' && (m === 'GET' || m === 'HEAD')) return this.serveFile(req, res, id)
      return send(res, 404, { err: 'yok' })
    } catch (e) {
      const code = e.status >= 400 && e.status < 600 ? e.status : 500
      if (code >= 500) log('klip API hatası:', m, req.url, '-', e.message)
      return send(res, code, { err: e.message, ...(e.extra || {}) })
    }
  }

  serveFile (req, res, id) {
    const j = this.get(id)
    const f = this.file(id)
    if (j.state !== 'ready' || !fs.existsSync(f)) return send(res, 409, { err: 'Klip henüz hazır değil' })
    const size = fs.statSync(f).size
    const range = parseRange(req.headers.range, size)
    if (range === 'invalid') return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    const { start, end } = range || { start: 0, end: size - 1 }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/x-matroska',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'inline; filename="klip.mkv"',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    })
    if (req.method === 'HEAD') return res.end()
    const s = fs.createReadStream(f, { start, end })
    s.on('error', () => res.destroy())
    res.on('close', () => s.destroy())
    s.pipe(res)
  }
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const firstLine = s => String(s || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || ''

function send (res, code, body) {
  if (res.headersSent) return res.end()
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson (req, limit = 64e3) {
  return new Promise((resolve, reject) => {
    let d = ''
    req.setEncoding('utf8')
    req.on('data', c => { d += c; if (d.length > limit) { reject(new KlipError('istek çok büyük', 413)); req.destroy() } })
    req.on('end', () => {
      try { const v = JSON.parse(d || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); resolve(v) } catch { reject(new KlipError('geçersiz JSON')) }
    })
    req.on('error', reject)
  })
}
