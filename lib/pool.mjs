// Motor havuzu: her etkin indirme kendi rqbit sürecinde çalışır (kendi API kapısı, eş kapısı, sınırı).
// Böylece indirme sınırı indirme başına verilir ve çalışırken POST /torrents/limits ile değiştirilir.
//
//   kontrol motoru  cfg.rqbitApiPort / cfg.rqbitPeerPort, klasör data/rqbit; torrent tutmaz, yalnızca
//                   eklemeden dosya listesi (list_only) için kullanılır.
//   öğe motorları   "yuva" k: API cfg.engineApiPortBase + k, eş cfg.enginePeerPortBase + k,
//                   klasör data/rqbit/motorlar/<k> (rqbit.pid, rqbit.log, rqbit.err). Yuva öğede (item.slot)
//                   saklanır: servis yeniden başlasa da aynı indirme aynı kapıları kullanır.
//
// Süreç yalnızca öğe "resolving" ya da "downloading" iken vardır; duraklatılınca, bitince, silinince kapatılır.
// Servis çökerse pid dosyaları bir sonraki açılışta okunur ve yalnızca bizim başlattığımız süreçler kapatılır.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { Engine, killStalePidFiles } from './engine.mjs'
import { log } from './log.mjs'

function canBind (port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, host, () => s.close(() => resolve(true)))
  })
}

export class EnginePool extends EventEmitter {
  /**
   * limitsFor(ih) -> { down, up } bayt/sn (0 = sınırsız); controlLimits() -> { down, up }
   * slotsInUse() -> Set (kütüphanedeki öğelerin yuvaları)
   */
  constructor (cfg, { limitsFor, controlLimits, slotsInUse }) {
    super()
    this.cfg = cfg
    this.limitsFor = limitsFor
    this.slotsInUse = slotsInUse
    this.dir = path.join(cfg.rqbitDir, 'motorlar')
    this.control = new Engine(cfg, { name: 'kontrol', limits: controlLimits })
    this.engines = new Map() // infoHash -> Engine
    this.lock = Promise.resolve()
    this.restartsDone = 0 // kapatılmış öğe motorlarının yeniden başlama sayısı (toplam için)
  }

  get ready () { return this.control.ready }
  slotDir (k) { return path.join(this.dir, String(k)) }
  ports (k) { return { apiPort: this.cfg.engineApiPortBase + k, peerPort: this.cfg.enginePeerPortBase + k } }

  /** Açılışta: önceki çalışmadan kalan (servis çökmüş) bütün motor süreçlerini kapatır. */
  sweep () {
    const files = []
    let dirs = []
    try { dirs = fs.readdirSync(this.dir) } catch {}
    for (const d of dirs) {
      if (!/^\d+$/.test(d)) continue
      const f = path.join(this.dir, d, 'rqbit.pid')
      if (fs.existsSync(f)) files.push({ file: f, apiPort: this.ports(+d).apiPort })
    }
    if (fs.existsSync(this.control.pidFile)) files.push({ file: this.control.pidFile, apiPort: this.control.apiPort })
    if (files.length) killStalePidFiles(this.cfg.rqbitExe, files)
  }

  async start () {
    fs.mkdirSync(this.dir, { recursive: true })
    this.sweep()
    await this.control.start()
  }

  get (ih) { return this.engines.get(ih) }

  async slotFree (k, taken) {
    if (taken.has(k)) return false
    const { apiPort, peerPort } = this.ports(k)
    if ([this.cfg.port, this.cfg.rqbitApiPort, this.cfg.rqbitPeerPort, this.cfg.debugPort].includes(apiPort) ||
      [this.cfg.port, this.cfg.rqbitApiPort, this.cfg.rqbitPeerPort, this.cfg.debugPort].includes(peerPort)) return false
    return (await canBind(apiPort)) && (await canBind(peerPort, this.cfg.peerListenIp || '0.0.0.0'))
  }

  /** Öğenin motorunu döndürür; yoksa yuva ayırıp başlatır (hazır olmasını beklemez). */
  ensure (item) {
    const run = this.lock.then(() => this._ensure(item))
    this.lock = run.catch(() => {})
    return run
  }

  async _ensure (item) {
    const ih = item.infoHash
    const have = this.engines.get(ih)
    if (have) return have
    const taken = new Set([...this.slotsInUse(item)].filter(k => k !== item.slot))
    for (const e of this.engines.values()) taken.add(e.slot)
    let k = Number.isInteger(item.slot) && item.slot >= 0 && item.slot < this.cfg.engineSlots ? item.slot : null
    if (k == null || !(await this.slotFree(k, taken))) {
      const old = k
      k = null
      for (let i = 0; i < this.cfg.engineSlots; i++) if (await this.slotFree(i, taken)) { k = i; break }
      if (k == null) throw Object.assign(new Error('Boş motor kapısı bulunamadı (çok fazla eşzamanlı indirme ya da kapılar dolu)'), { status: 503 })
      if (old != null) log('motor yuvası değişti (kapı kullanımda):', old, '->', k)
    }
    item.slot = k
    const eng = new Engine(this.cfg, { name: 'motor ' + k + ' ' + (item.name || ih).slice(0, 40), ...this.ports(k), dir: this.slotDir(k), limits: () => this.limitsFor(ih) })
    eng.slot = k
    eng.infoHash = ih
    eng.on('ready', n => { if (n > 1 && this.engines.get(ih) === eng) this.emit('restarted', ih) })
    eng.on('down', () => this.emit('down', ih))
    this.engines.set(ih, eng)
    eng.start().catch(e => log('motor başlatılamadı:', e.message))
    return eng
  }

  /** Öğenin motorunu kapatır (süreç öldürülür; dosyalar diskte kalır). */
  stop (ih) {
    const e = this.engines.get(ih)
    if (!e) return false
    this.engines.delete(ih)
    this.restartsDone += e.restarts
    e.stop()
    log('motor kapatıldı:', e.name, 'pid', e.pid ?? '-')
    return true
  }

  stopAll () {
    for (const ih of [...this.engines.keys()]) this.stop(ih)
    this.control.stop()
  }

  /** Bir öğenin sınırını çalışan sürecine uygular (süreç yoksa bir sonraki başlatmada bayrakla verilir). */
  async apply (ih) {
    const e = this.engines.get(ih)
    if (!e || !e.ready) return null
    return e.applyLimits()
  }

  async applyAll () {
    const all = [this.control, ...this.engines.values()].filter(e => e.ready)
    await Promise.all(all.map(e => e.applyLimits().catch(err => log('sınır uygulanamadı:', e.name, err.message))))
  }

  /** Bütün çalışan süreçlerde istenen sınır değiştiyse uygular (öncelik geçişleri). */
  async syncAll () {
    await Promise.all([...this.engines.values()].map(e => e.syncLimits().catch(err => log('sınır uygulanamadı:', e.name, err.message))))
  }

  restarts () {
    let n = this.control.restarts + this.restartsDone
    for (const e of this.engines.values()) n += e.restarts
    return n
  }

  list () {
    return [...this.engines.values()].map(e => ({
      infoHash: e.infoHash, slot: e.slot, apiPort: e.apiPort, peerPort: e.peerPort, pid: e.pid, ready: e.ready, restarts: e.restarts, limits: e.argLimits
    }))
  }
}
