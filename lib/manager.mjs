// İndirme yöneticisi: ekle (dosya seçimiyle), duraklat, sürdür, iptal, sil; canlı durum;
// indirme bitince torrenti duraklatır (yükleme yapılmaz); motor yeniden başlayınca durumu eşitler.
//
// Öğe durumları:
//   resolving   torrent bilgisi (metadata) bekleniyor; süre aşımı -> error
//   downloading motorda, iniyor
//   paused      kullanıcı durdurdu (ya da eski kayıttan taşındı); motor hiçbir şey indirmiyor
//   completed   seçili dosyaların hepsi indi; torrent motorda duraklatılmış (yükleme yok)
//   error       başlatılamadı / metadata gelmedi / motor hata verdi; "sürdür" yeniden dener
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseTorrent, withTrackers } from './bencode.mjs'
import { mapPackFiles, parseEpisode } from './episodes.mjs'
import { VIDEO_EXT, parseStremioId } from './library.mjs'
import { log } from './log.mjs'

export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce'
]

export class UserError extends Error {
  constructor (message, status = 400) { super(message); this.status = status }
}

const isHash = s => /^[a-f0-9]{40}$/.test(s)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** magnet bağlantısından infoHash ve tracker'lar. */
export function parseMagnet (m) {
  try {
    const u = new URL(m)
    if (u.protocol !== 'magnet:') return null
    const xt = u.searchParams.getAll('xt').find(x => /^urn:btih:/i.test(x))
    if (!xt) return null
    let ih = xt.slice(9)
    if (/^[a-z2-7]{32}$/i.test(ih)) ih = base32ToHex(ih)
    return { infoHash: ih.toLowerCase(), trackers: u.searchParams.getAll('tr'), name: u.searchParams.get('dn') || '' }
  } catch { return null }
}

function base32ToHex (s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of s.toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0')
  let hex = ''
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

export class Manager {
  constructor ({ cfg, engine, library, meta }) {
    this.cfg = cfg
    this.engine = engine
    this.lib = library
    this.meta = meta
    this.inflight = new Map() // infoHash -> { ac, promise }
    this.polling = false
    engine.on('ready', () => this.reconcile().catch(e => log('eşitleme hatası:', e.message)))
    engine.on('down', () => { for (const i of this.lib.all()) i.live = null })
  }

  start () {
    this.pollTimer = setInterval(() => this.poll().catch(e => log('durum sorgusu hatası:', e.message)), this.cfg.pollMs)
  }

  stop () {
    clearInterval(this.pollTimer)
    for (const { ac } of this.inflight.values()) ac.abort(new Error('kapanıyor'))
    this.lib.saveNow()
  }

  // ------------------------------------------------------------ yardımcılar

  torrentFile (ih) { return path.join(this.cfg.torrentDir, ih + '.torrent') }

  readCachedTorrent (ih) {
    try { return fs.readFileSync(this.torrentFile(ih)) } catch { return null }
  }

  magnet (item) {
    const tr = [...new Set([...(item.trackers || []), ...(this.cfg.loopback ? [] : DEFAULT_TRACKERS)])]
    return `magnet:?xt=urn:btih:${item.infoHash}` + tr.map(t => `&tr=${encodeURIComponent(t)}`).join('')
  }

  get (ih) {
    const item = this.lib.get(ih)
    if (!item) throw new UserError('Böyle bir indirme yok', 404)
    return item
  }

  /** Torrent dosya listesinden varsayılan seçim: istenen bölüm, yoksa en büyük video. */
  defaultFiles (files, item, stremioId) {
    const vids = files.filter(f => VIDEO_EXT.test(f.name) && !/\bsample\b/i.test((f.components || [f.name]).join('/')))
    const { season, episode } = parseStremioId(stremioId)
    if (season != null && episode != null) {
      const map = mapPackFiles(files, { torrentName: item.name })
      const hit = files.find(f => { const e = map.get(f.idx); return e && e.season === season && e.episode === episode })
      if (hit) return [hit.idx]
    }
    const pool = vids.length ? vids : files
    const big = [...pool].sort((a, b) => b.length - a.length)[0]
    return big ? [big.idx] : []
  }

  /** Motorun verdiği dosya listesini öğeye işler (yollar, seçim, Stremio eşlemesi). */
  applyDetails (item, details, requested = {}) {
    item.name = details.name || item.name
    item.outputFolder = details.output_folder ? path.normalize(details.output_folder) : item.outputFolder
    const old = item.files || []
    const files = (details.files || []).map((f, idx) => {
      const components = f.components || [f.name]
      const prev = old.find(o => o.idx === idx) ||
        old.find(o => o.idx == null && o.name && o.name === components[components.length - 1])
      return {
        idx,
        name: components[components.length - 1],
        components,
        path: item.outputFolder ? path.join(item.outputFolder, ...components) : prev?.path || null,
        length: f.length,
        selected: !!f.included,
        progressBytes: prev?.progressBytes || 0,
        videoId: prev?.videoId || null,
        season: prev?.season ?? null,
        episode: prev?.episode ?? null
      }
    })
    // Eski kayıttaki yol farklıysa uyar (yeniden indirme olabilir)
    for (const o of old) {
      const n = files.find(f => f.idx === o.idx || (o.idx == null && f.name === o.name))
      if (o.path && n?.path && path.resolve(o.path) !== path.resolve(n.path)) log('uyarı: dosya yolu değişti:', o.path, '->', n.path)
    }
    item.files = files
    this.assignVideoIds(item, requested)
  }

  assignVideoIds (item, { stremioId, fileIdx } = {}) {
    if (!item.imdbId) return
    const files = item.files
    if (item.type === 'series') {
      const map = mapPackFiles(files, { torrentName: item.name })
      for (const f of files) {
        const ep = map.get(f.idx)
        if (ep && !f.videoId) { f.season = ep.season; f.episode = ep.episode; f.videoId = `${item.imdbId}:${ep.season}:${ep.episode}` }
      }
      if (stremioId && Number.isInteger(fileIdx)) {
        const f = files.find(x => x.idx === fileIdx)
        const { season, episode } = parseStremioId(stremioId)
        if (f && season != null) { f.videoId = stremioId; f.season = season; f.episode = episode }
      }
    } else {
      // Film: seçili en büyük video ana dosyadır
      if (files.some(f => f.videoId === item.imdbId)) return
      const main = Number.isInteger(fileIdx) ? files.find(f => f.idx === fileIdx)
        : files.filter(f => f.selected && VIDEO_EXT.test(f.name)).sort((a, b) => b.length - a.length)[0]
      if (main) main.videoId = item.imdbId
    }
  }

  // ------------------------------------------------------------ ekle

  /**
   * opts: { infoHash | magnet, trackers[], files: [idx] | null, type, id (Stremio kimliği), title, source }
   * Hemen döner; metadata ve motor ekleme arka planda yürür.
   */
  add (opts) {
    let ih = String(opts.infoHash || '').toLowerCase()
    let trackers = Array.isArray(opts.trackers) ? opts.trackers.filter(t => typeof t === 'string' && /^(udp|https?|wss?):\/\//.test(t)) : []
    if (opts.magnet) {
      const m = parseMagnet(String(opts.magnet))
      if (!m) throw new UserError('Geçersiz magnet bağlantısı')
      ih = m.infoHash
      trackers = [...new Set([...trackers, ...m.trackers])]
    }
    if (!isHash(ih)) throw new UserError('Geçersiz infoHash')
    const files = Array.isArray(opts.files) ? [...new Set(opts.files.map(Number))].filter(n => Number.isInteger(n) && n >= 0) : null
    if (files && !files.length) throw new UserError('En az bir dosya seçilmeli')
    const sid = opts.id ? String(opts.id) : ''
    const { imdbId, season, episode } = parseStremioId(sid)
    const type = ['movie', 'series'].includes(opts.type) ? opts.type : null

    const existing = this.lib.get(ih)
    if (existing) {
      if (files?.length) {
        const sel = new Set(existing.files.filter(f => f.selected).map(f => f.idx))
        const missing = files.filter(i => !sel.has(i))
        if (missing.length) this.select(ih, [...sel, ...missing], { stremioId: sid, fileIdx: files.length === 1 ? files[0] : undefined }).catch(e => log('seçim güncellenemedi:', e.message))
      }
      return { item: existing, existed: true }
    }

    const item = {
      infoHash: ih,
      name: '',
      title: String(opts.title || '').split('\n')[0] || '',
      type,
      imdbId: /^tt\d+$/.test(imdbId || '') ? imdbId : null,
      displayName: '',
      source: opts.source && typeof opts.source === 'object' ? opts.source : (opts.title ? { title: String(opts.title) } : {}),
      trackers,
      state: 'resolving',
      error: null,
      inEngine: false,
      addedAt: Date.now(),
      completedAt: null,
      outputFolder: null,
      files: [],
      wantedFiles: files,
      request: { stremioId: sid || null, fileIdx: files?.length === 1 ? files[0] : null }
    }
    if (files && sid && season != null && files.length === 1) {
      item.files = [{ idx: files[0], name: '', path: null, length: 0, selected: true, progressBytes: 0, videoId: sid, season, episode }]
    }
    this.lib.set(item)
    log('⬇ eklendi:', item.title || ih)
    if (item.imdbId && type) this.meta.fetch(type, item.imdbId).then(m => { if (m?.name) { item.displayName = m.name; this.lib.saveNow() } })
    this.activate(item)
    return { item, existed: false }
  }

  /** Öğeyi motora ekler (gerekirse metadata çözer). Aynı anda tek çalışma. */
  activate (item) {
    const ih = item.infoHash
    if (this.inflight.has(ih)) return this.inflight.get(ih).promise
    const ac = new AbortController()
    const timeoutMs = this.cfg.metadataTimeoutSec * 1000
    let timedOut = false
    let retry = false
    const timer = setTimeout(() => { timedOut = true; ac.abort(new Error('metadata zaman aşımı')) }, timeoutMs)
    item.state = 'resolving'
    item.error = null
    this.lib.save()
    const promise = (async () => {
      try {
        await this.engine.whenReady(timeoutMs)
        const req = item.request || {}
        let wanted = item.wantedFiles ?? (item.files?.length ? item.files.filter(f => f.selected && f.idx != null).map(f => f.idx) : null)
        if (wanted && !wanted.length) wanted = null
        let res
        if (await this.engine.has(ih)) {
          // Motorda zaten var (ör. servis çökmeden hemen önce eklenmiş): seçimi uygula, sürdür
          res = { details: await this.engine.details(ih) }
          if (wanted) await this.engine.updateOnlyFiles(ih, wanted)
          await this.engine.resume(ih)
          res = { details: await this.engine.details(ih) }
        } else {
          let bytes = this.readCachedTorrent(ih)
          if (bytes) {
            if (!wanted) {
              const t = parseTorrent(bytes)
              item.name = item.name || t.name
              wanted = this.defaultFiles(t.files, item, req.stremioId)
            }
            res = await this.engine.add(withTrackers(bytes, item.trackers), { onlyFiles: wanted, signal: ac.signal })
          } else {
            const magnet = this.magnet(item)
            if (!wanted) {
              const pre = await this.engine.add(magnet, { listOnly: true, signal: ac.signal })
              const files = (pre.details?.files || []).map((f, idx) => ({ idx, name: f.name, components: f.components, length: f.length }))
              item.name = pre.details?.name || item.name
              wanted = this.defaultFiles(files, item, req.stremioId)
            }
            res = await this.engine.add(magnet, { onlyFiles: wanted, signal: ac.signal })
            try {
              bytes = await this.engine.metadata(ih)
              parseTorrent(bytes)
              fs.writeFileSync(this.torrentFile(ih), bytes)
            } catch (e) { log('torrent dosyası saklanamadı:', e.message) }
          }
          await this.engine.addExtraPeers(ih)
        }
        clearTimeout(timer)
        if (ac.signal.aborted) throw ac.signal.reason
        this.applyDetails(item, res.details, { stremioId: req.stremioId, fileIdx: req.fileIdx })
        item.wantedFiles = null
        item.inEngine = true
        if (item.pauseRequested) {
          await this.engine.pause(ih)
          item.state = 'paused'
        } else {
          item.state = 'downloading'
        }
        item.pauseRequested = false
        this.lib.saveNow()
        log('▶ motora eklendi:', item.name || ih)
      } catch (e) {
        clearTimeout(timer)
        if (!this.lib.get(ih)) return // iptal edildi
        // Kesme, ekleme tam bitmişken geldiyse torrent motorda olabilir: durdur ve kaydet
        if (item.pauseRequested || timedOut) {
          try {
            if (await this.engine.has(ih)) { await this.engine.pause(ih); item.inEngine = true }
          } catch {}
        }
        if (item.pauseRequested && !timedOut) {
          item.state = 'paused'
          item.pauseRequested = false
        } else if (timedOut) {
          item.state = 'error'
          item.error = `Torrent bilgisi ${this.cfg.metadataTimeoutSec} sn içinde alınamadı (kaynak bulunamadı olabilir). "Sürdür" ile yeniden denenebilir.`
          log('✖ metadata zaman aşımı:', item.title || ih)
        } else if (e.status === 503 && !this.engine.stopped) {
          // Motor o sırada yeniden başlıyordu: hata sayma, birazdan yeniden dene
          retry = true
          log('motor hazır değil, ekleme yeniden denenecek:', item.title || ih)
        } else {
          item.state = 'error'
          item.error = e.message || String(e)
          log('✖ başlatılamadı:', item.title || ih, '-', item.error)
        }
        this.lib.saveNow()
      } finally {
        this.inflight.delete(ih)
        if (retry) setTimeout(() => { if (this.lib.get(ih) === item && item.state === 'resolving') this.activate(item) }, 3000)
      }
    })()
    this.inflight.set(ih, { ac, promise })
    return promise
  }

  // ------------------------------------------------------------ duraklat / sürdür / iptal / sil / seçim

  async pause (ih) {
    const item = this.get(ih)
    if (item.state === 'completed') throw new UserError('İndirme zaten tamamlandı', 409)
    if (item.state === 'paused') return item
    if (this.inflight.has(ih)) {
      item.pauseRequested = true
      this.inflight.get(ih).ac.abort(new Error('duraklatıldı'))
      await this.inflight.get(ih)?.promise
    }
    if (item.inEngine) {
      try { await this.engine.pause(ih) } catch (e) { if (e.status !== 404) throw e; item.inEngine = false }
    }
    item.state = 'paused'
    item.live = null
    this.lib.saveNow()
    log('⏸ duraklatıldı:', item.name || ih)
    return item
  }

  async resume (ih) {
    const item = this.get(ih)
    if (item.state === 'downloading' || item.state === 'resolving') return item
    if (item.state === 'completed' && this.allSelectedComplete(item)) return item
    if (item.inEngine && await this.engine.has(ih)) {
      await this.engine.resume(ih)
      item.state = 'downloading'
      item.error = null
      this.lib.saveNow()
    } else {
      item.inEngine = false
      this.activate(item)
    }
    log('▶ sürdürüldü:', item.name || ih)
    return item
  }

  /** İndirmeyi durdurur, inmiş kısmı siler ve öğeyi kaldırır (tamamlanmamış öğeler için). */
  async cancel (ih) {
    const item = this.get(ih)
    if (item.state === 'completed') throw new UserError('Tamamlanmış indirme iptal edilemez; silin', 409)
    return this.remove(ih, { keepFiles: false })
  }

  /** Öğeyi kaldırır; keepFiles değilse dosyalarını da siler. */
  async remove (ih, { keepFiles = false } = {}) {
    const item = this.get(ih)
    ih = item.infoHash // anahtar büyük/küçük harf fark etmeksizin kayıttaki biçime çevrilir
    const fl = this.inflight.get(ih)
    this.lib.delete(ih) // önce kaldır: arka plandaki işler bunu görüp durur
    if (fl) { fl.ac.abort(new Error('iptal')); await fl.promise.catch(() => {}) }
    let inEngine = item.inEngine
    try { inEngine = await this.engine.has(ih) } catch {}
    if (inEngine) {
      try { keepFiles ? await this.engine.forget(ih) : await this.engine.delete(ih) } catch (e) { log('motordan kaldırılamadı:', e.message) }
    }
    if (!keepFiles) await this.deleteFiles(item)
    await fsp.rm(this.torrentFile(ih), { force: true }).catch(() => {})
    if (item.imdbId) await this.meta.remove(item.imdbId, () => this.lib.all().some(x => x.imdbId === item.imdbId))
    log('🗑 kaldırıldı:', item.name || item.title || ih, keepFiles ? '(dosyalar korundu)' : '')
    return true
  }

  inside (p, dir) {
    if (!p || !dir) return false
    const rel = path.relative(path.resolve(dir), path.resolve(p))
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  async deleteFiles (item) {
    const roots = [this.cfg.downloadDir, item.outputFolder].filter(Boolean)
    for (const f of item.files || []) {
      if (!f.path) continue
      if (!roots.some(r => this.inside(f.path, r))) { log('silinmedi (indirme klasörü dışında):', f.path); continue }
      await fsp.rm(f.path, { force: true }).catch(e => log('silinemedi:', f.path, e.message))
      // Boşalan alt klasörleri indirme klasörüne kadar temizle
      let dir = path.dirname(f.path)
      while (this.inside(dir, this.cfg.downloadDir)) {
        try { await fsp.rmdir(dir) } catch { break }
        dir = path.dirname(dir)
      }
    }
  }

  /** Seçili dosyaları değiştirir (ör. paketten bölüm eklemek/çıkarmak). */
  async select (ih, files, requested = {}) {
    const item = this.get(ih)
    const sel = [...new Set(files.map(Number))].filter(n => Number.isInteger(n) && n >= 0)
    if (!sel.length) throw new UserError('En az bir dosya seçilmeli')
    if (item.files.length && item.files.every(f => f.length) && sel.some(i => !item.files.find(f => f.idx === i))) throw new UserError('Geçersiz dosya numarası')
    if (!item.inEngine) {
      item.wantedFiles = sel
      for (const f of item.files) f.selected = sel.includes(f.idx)
      if (requested.stremioId) item.request = { stremioId: requested.stremioId, fileIdx: requested.fileIdx ?? null }
      if (item.state === 'completed' && !this.allSelectedComplete(item)) this.activate(item)
      this.lib.saveNow()
      return item
    }
    await this.engine.updateOnlyFiles(ih, sel)
    this.applyDetails(item, await this.engine.details(ih), requested)
    if (item.state === 'completed' && !this.allSelectedComplete(item)) {
      await this.engine.resume(ih)
      item.state = 'downloading'
      item.completedAt = null
    }
    this.lib.saveNow()
    return item
  }

  allSelectedComplete (item) {
    const sel = item.files.filter(f => f.selected)
    return sel.length > 0 && sel.every(f => f.length > 0 && f.progressBytes >= f.length)
  }

  // ------------------------------------------------------------ canlı durum

  async poll () {
    if (this.polling || !this.engine.ready) return
    this.polling = true
    try {
      for (const item of this.lib.all()) {
        if (item.state !== 'downloading' || !item.inEngine) continue
        let st
        try { st = await this.engine.stats(item.infoHash) } catch (e) {
          if (e.status === 404 && this.lib.get(item.infoHash)) {
            log('torrent motordan düştü, yeniden ekleniyor:', item.name)
            item.inEngine = false
            item.live = null
            this.activate(item)
          }
          continue
        }
        if (!this.lib.get(item.infoHash) || item.state !== 'downloading') continue
        const live = st.live
        item.live = {
          engineState: st.state,
          downloadSpeed: Math.round((live?.download_speed?.mbps || 0) * 1048576),
          uploadSpeed: Math.round((live?.upload_speed?.mbps || 0) * 1048576),
          eta: live?.time_remaining?.duration?.secs ?? null,
          peers: live?.snapshot?.peer_stats?.live ?? 0,
          uploadedBytes: st.uploaded_bytes || 0
        }
        if (st.state === 'error') {
          item.state = 'error'
          item.error = 'Motor hatası: ' + (st.error || 'bilinmiyor')
          item.live = null
          this.lib.saveNow()
          continue
        }
        if (st.state !== 'live') continue // initializing: diskteki veri doğrulanıyor, ilerleme güvenilmez
        const fp = st.file_progress || []
        for (const f of item.files) if (f.idx != null && fp[f.idx] != null) f.progressBytes = Math.min(f.length, fp[f.idx])
        if (st.finished) await this.onFinished(item)
        this.lib.save()
      }
    } finally { this.polling = false }
  }

  async onFinished (item) {
    try { await this.engine.pause(item.infoHash) } catch (e) { log('tamamlanınca duraklatılamadı:', e.message); return }
    for (const f of item.files) if (f.selected) f.progressBytes = f.length
    item.state = 'completed'
    item.completedAt = Date.now()
    item.live = null
    this.lib.saveNow()
    log('✔ indirildi (torrent duraklatıldı, yükleme yok):', item.name)
  }

  /** Motor (yeniden) hazır olduğunda kütüphane ile motoru eşitler. */
  async reconcile () {
    const list = await this.engine.list()
    const inEngine = new Set((list.torrents || []).map(t => String(t.info_hash).toLowerCase()))
    for (const item of this.lib.all()) {
      const ih = item.infoHash
      const present = inEngine.has(ih)
      if (item.state === 'downloading' || item.state === 'resolving') {
        if (this.inflight.has(ih)) continue
        if (present) {
          item.inEngine = true
          try { await this.engine.resume(ih) } catch (e) { log('sürdürülemedi:', item.name, e.message) }
        } else {
          if (item.inEngine) log('torrent motorda yok (başlatılamamış olabilir), yeniden ekleniyor:', item.name || ih)
          item.inEngine = false
          this.activate(item)
        }
      } else {
        item.inEngine = present
        if (present) { try { await this.engine.pause(ih) } catch {} }
      }
    }
    for (const ih of inEngine) {
      if (!this.lib.get(ih)) {
        log('kütüphanede olmayan torrent motordan çıkarıldı (dosyalar korunur):', ih)
        try { await this.engine.forget(ih) } catch {}
      }
    }
    this.lib.saveNow()
  }

  // ------------------------------------------------------------ oynatma için

  pickFile (item, idx, videoId) {
    const files = item.files || []
    if (Number.isInteger(idx)) return files.find(f => f.idx === idx) || null
    if (videoId) {
      const f = files.find(f => f.videoId === videoId && f.selected)
      if (f) return f
    }
    const vids = files.filter(f => f.selected && VIDEO_EXT.test(f.name || f.path || ''))
    return [...(vids.length ? vids : files.filter(f => f.selected))].sort((a, b) => b.length - a.length)[0] || null
  }

  fileOnDisk (f) {
    return f && f.length > 0 && f.progressBytes >= f.length && f.path && fs.existsSync(f.path)
  }

  /**
   * Oynatma için dosyayı hazırlar. Dosya tamamsa diskten, değilse motor akışından.
   * Öğe yoksa oluşturur; duraklatılmışsa sürdürür; dosya seçili değilse seçime ekler.
   */
  async playable ({ infoHash, fileIdx, type, id, create = true }) {
    const ih = String(infoHash).toLowerCase()
    let item = this.lib.get(ih)
    if (!item) {
      if (!create) throw new UserError('Böyle bir indirme yok', 404)
      item = this.add({ infoHash: ih, files: Number.isInteger(fileIdx) ? [fileIdx] : null, type, id }).item
    }
    let file = this.pickFile(item, fileIdx, id)
    if (this.fileOnDisk(file)) return { mode: 'disk', item, file }
    if (file && file.idx != null && item.inEngine && !file.selected) {
      await this.select(ih, [...item.files.filter(f => f.selected).map(f => f.idx), file.idx], { stremioId: id, fileIdx: file.idx })
    }
    if (item.state === 'paused' || item.state === 'error' || (item.state === 'completed' && !this.fileOnDisk(file))) {
      if (item.state === 'completed') { item.state = 'paused' }
      if (Number.isInteger(fileIdx) && !item.inEngine) {
        const sel = new Set(item.files.filter(f => f.selected && f.idx != null).map(f => f.idx))
        sel.add(fileIdx)
        item.wantedFiles = [...sel]
      }
      await this.resume(ih)
    }
    const deadline = Date.now() + (this.cfg.metadataTimeoutSec + 15) * 1000
    while (!(item.inEngine && item.state === 'downloading')) {
      if (!this.lib.get(ih)) throw new UserError('İndirme kaldırıldı', 410)
      if (item.state === 'error') throw new UserError(item.error || 'İndirme başlatılamadı', 502)
      if (item.state === 'paused') throw new UserError('İndirme duraklatıldı', 409)
      if (item.state === 'completed') break
      if (Date.now() > deadline) throw new UserError('İndirme zamanında başlamadı', 504)
      await sleep(200)
    }
    file = this.pickFile(item, fileIdx, id)
    if (!file || file.idx == null) throw new UserError('Torrentte oynatılabilir dosya yok', 404)
    if (this.fileOnDisk(file)) return { mode: 'disk', item, file }
    if (!file.selected) await this.select(ih, [...item.files.filter(f => f.selected).map(f => f.idx), file.idx])
    return { mode: 'stream', item, file, url: this.engine.streamUrl(ih, file.idx) }
  }

  // ------------------------------------------------------------ önizleme (eklemeden dosya listesi)

  /** Torrentin dosya listesi ve bölüm eşlemesi; torrent eklenmez. */
  async torrentFiles (ih, { trackers = [], season = null } = {}) {
    ih = String(ih).toLowerCase()
    if (!isHash(ih)) throw new UserError('Geçersiz infoHash')
    this.filesCache ??= new Map()
    let t = this.filesCache.get(ih)
    if (!t) {
      const bytes = this.readCachedTorrent(ih)
      if (bytes) {
        const p = parseTorrent(bytes)
        t = { name: p.name, files: p.files }
      } else {
        const item = this.lib.get(ih)
        if (item?.inEngine && item.files?.length) {
          t = { name: item.name, files: item.files.map(f => ({ idx: f.idx, name: f.name, components: f.components || [f.name], length: f.length })) }
        } else {
          const magnet = this.magnet({ infoHash: ih, trackers })
          let pre
          try {
            pre = await this.engine.add(magnet, { listOnly: true, signal: AbortSignal.timeout(this.cfg.metadataTimeoutSec * 1000) })
          } catch (e) {
            if (e.status === 504 || e.name === 'TimeoutError' || e.name === 'AbortError') throw new UserError(`Torrent bilgisi ${this.cfg.metadataTimeoutSec} sn içinde alınamadı`, 504)
            throw e
          }
          t = { name: pre.details?.name || '', files: (pre.details?.files || []).map((f, idx) => ({ idx, name: f.name, components: f.components || [f.name], length: f.length })) }
        }
      }
      this.filesCache.set(ih, t)
      if (this.filesCache.size > 200) this.filesCache.delete(this.filesCache.keys().next().value)
    }
    const map = mapPackFiles(t.files, { torrentName: t.name })
    const files = t.files.map(f => {
      const ep = map.get(f.idx)
      return { idx: f.idx, name: f.name, path: (f.components || [f.name]).join('/'), length: f.length, video: VIDEO_EXT.test(f.name), season: ep?.season ?? null, episode: ep?.episode ?? null }
    })
    const episodes = files.filter(f => f.episode != null && (season == null || f.season === +season))
      .sort((a, b) => a.season - b.season || a.episode - b.episode || b.length - a.length)
      .filter((f, i, arr) => i === 0 || arr[i - 1].season !== f.season || arr[i - 1].episode !== f.episode)
      .map(f => ({ season: f.season, episode: f.episode, fileIdx: f.idx, name: f.name, length: f.length }))
    return {
      infoHash: ih,
      name: t.name,
      totalBytes: files.reduce((a, f) => a + f.length, 0),
      files,
      episodes,
      episodeCount: episodes.length,
      episodesBytes: episodes.reduce((a, e) => a + e.length, 0)
    }
  }

  // ------------------------------------------------------------ görünüm

  playUrl (item, file) {
    const type = item.type || 'movie'
    const id = file?.videoId || item.imdbId || 'x'
    return `${this.cfg.base}/play/${type}/${encodeURIComponent(id)}/${item.infoHash}/${file && file.idx != null ? file.idx : 'x'}`
  }

  view (item) {
    const sel = (item.files || []).filter(f => f.selected)
    const size = sel.reduce((a, f) => a + (f.length || 0), 0)
    const done = sel.reduce((a, f) => a + Math.min(f.length || 0, f.progressBytes || 0), 0)
    const active = item.state === 'downloading' && item.live
    const main = this.pickFile(item, null, item.type === 'movie' ? item.imdbId : null)
    return {
      id: item.infoHash,
      infoHash: item.infoHash,
      name: item.name || item.title || item.infoHash,
      title: item.title,
      displayName: item.displayName || '',
      type: item.type,
      imdbId: item.imdbId,
      state: item.state,
      error: item.error || null,
      addedAt: item.addedAt,
      completedAt: item.completedAt,
      sizeBytes: size,
      doneBytes: done,
      progress: size ? done / size : 0,
      percent: size ? Math.floor((done / size) * 1000) / 10 : 0,
      downloadSpeed: active ? item.live.downloadSpeed : 0,
      uploadSpeed: active ? item.live.uploadSpeed : 0,
      eta: active ? item.live.eta : null,
      peers: active ? item.live.peers : 0,
      engineState: active ? item.live.engineState : null,
      source: item.source || {},
      poster: item.imdbId ? this.meta.localImg(item.imdbId, 'poster', '') : '',
      playUrl: main ? this.playUrl(item, main) : null,
      files: (item.files || []).map(f => ({
        idx: f.idx,
        name: f.name,
        path: f.path,
        length: f.length,
        selected: !!f.selected,
        doneBytes: Math.min(f.length || 0, f.progressBytes || 0),
        progress: f.length ? Math.min(1, (f.progressBytes || 0) / f.length) : 0,
        complete: !!(f.length && f.progressBytes >= f.length),
        videoId: f.videoId || null,
        season: f.season ?? null,
        episode: f.episode ?? null,
        playUrl: f.selected ? this.playUrl(item, f) : null
      }))
    }
  }

  async summary () {
    const items = this.lib.all().map(i => this.view(i))
    let free = null; let total = null
    try {
      const s = await fsp.statfs(this.cfg.downloadDir)
      free = s.bavail * s.bsize
      total = s.blocks * s.bsize
    } catch {}
    return {
      downloadDir: this.cfg.downloadDir,
      usedBytes: items.reduce((a, i) => a + i.doneBytes, 0),
      diskFreeBytes: free,
      diskTotalBytes: total,
      downloadSpeed: items.reduce((a, i) => a + i.downloadSpeed, 0),
      active: items.filter(i => i.state === 'downloading' || i.state === 'resolving').length,
      engine: { ready: this.engine.ready, restarts: this.engine.restarts, error: this.engine.lastError }
    }
  }
}
