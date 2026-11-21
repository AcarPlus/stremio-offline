// Güncelleme: package.json sürümü ile GitHub son sürümü (releases/latest) karşılaştırılır.
// Kurulum programıyla (exe) kurulmuşsa "Şimdi güncelle": sürümdeki StremioOffline-Kurulum*.exe indirilir, GitHub'ın
// yayımladığı boyut ve SHA-256 ile doğrulanır (özet yoksa kurulmaz), /SILENT /UPDATE ile başlatılır, servis kapanır;
// kurulum bitince servisi yeniden başlatır. İndirme yalnız https ve GitHub adreslerinden (her yönlendirme denetlenir).
// Elle kurulumda (geliştirme klasörü, eski zip) yalnız sürüm sayfası gösterilir.
// Ağ yoksa / depo yayında değilse (404) sessiz kalınır. Sınama: OFFLINE_GUNCELLEME_URL ile yerel sahte sunucu;
// sınama kipinde bu değişken yoksa ağa hiç çıkılmaz, kurulum programı hiç çalıştırılmaz (OFFLINE_GUNCELLEME_KURUCU yoksa).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { log } from './log.mjs'

export const KURULUM_ADI = /^StremioOffline-Kurulum[\w.-]*\.exe$/i
export const IZINLI_SUNUCULAR = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
export const KURULUM_ARGUMANLARI = ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPDATE']

/** Adres indirme için uygun mu: https + izinli GitHub sunucusu (sınamada izinliTum: yerel http de olur). */
export function adresUygun (u, izinliTum = false) {
  let x
  try { x = new URL(u) } catch { return false }
  if (x.username || x.password) return false
  if (izinliTum) return x.protocol === 'http:' || x.protocol === 'https:'
  return x.protocol === 'https:' && IZINLI_SUNUCULAR.includes(x.hostname.toLowerCase())
}

/** Bu klasör kurulum programıyla mı kuruldu? (Inno Setup kaldırıcısı unins000.exe kökte durur) */
export function exeKurulumu (root) {
  try { return fs.readdirSync(root).some(f => /^unins\d{3}\.exe$/i.test(f)) } catch { return false }
}

/** "v1.2.3" / "1.2" / "1.2.3-beta" -> [1,2,3] (ttag'in ön ek/son ek kısmı atılır); geçersizse null */
export function parseSurum (s) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(String(s || '').trim())
  return m ? [+m[1], +(m[2] || 0), +(m[3] || 0)] : null
}

/** a > b ise 1, a < b ise -1, eşitse 0 (geçersiz giriş: 0) */
export function karsilastir (a, b) {
  const x = parseSurum(a); const y = parseSurum(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}

export class Guncelleme {
  /**
   * calistir(program, argumanlar): kurulum programını servisten bağımsız başlatır (varsayılan: ayrık spawn).
   * cikis(): kurulum başladıktan sonra servisi kapatır (server.mjs verir). kuruluMu: exe kurulumu mu (sınamada verilir).
   */
  constructor ({ cfg, settings, fetchFn = fetch, calistir = null, cikis = null, kuruluMu = null }) {
    this.cfg = cfg
    this.settings = settings
    this.fetch = fetchFn
    this.calistir = calistir || varsayilanCalistir(cfg)
    this.cikis = cikis
    this.kuruluMu = kuruluMu ?? (() => cfg.updateInstalled ?? exeKurulumu(cfg.root))
    let cur = '0.0.0'
    try { cur = JSON.parse(fs.readFileSync(path.join(cfg.root, 'package.json'), 'utf8')).version || cur } catch {}
    this.current = cur
    this.state = { status: 'hic', latest: null, tag: null, url: null, checkedAt: null, error: null, setup: null }
    this.kurulum = { asama: 'yok', yuzde: 0, hata: null } // yok | indiriliyor | baslatildi | hata
    this.timers = []
    this.running = null
  }

  adres () {
    if (this.cfg.updateUrl) return this.cfg.updateUrl
    if (this.cfg.testMode) return null // sınama kipinde gerçek ağa çıkılmaz
    return `https://api.github.com/repos/${this.cfg.updateRepo}/releases/latest`
  }

  durum () {
    const s = this.state
    return {
      current: this.current,
      status: s.status, // hic | guncel | yeni | surum-yok | denetlenemedi
      available: s.status === 'yeni',
      latest: s.latest, tag: s.tag, url: s.url,
      checkedAt: s.checkedAt, error: s.error,
      autoUpdateCheck: this.settings.autoUpdateCheck,
      repo: this.cfg.updateRepo,
      // Uygulama içinden kurulabilir mi: exe kurulumu + yeni sürümde doğrulanabilir kurulum programı
      exeKurulumu: !!this.kuruluMu(),
      kurulabilir: s.status === 'yeni' && !!s.setup?.sha256 && !!this.kuruluMu(),
      setupSize: s.setup?.size || 0,
      kurulum: { ...this.kurulum }
    }
  }

  /** Sunucu açılışından ~1 dk sonra, sonra 24 saatte bir (ayar kapalıysa o tur atlanır). Sınama kipinde sahte adres yoksa kapalı. */
  start () {
    if (this.cfg.testMode && !this.cfg.updateUrl) return
    const tur = () => { if (this.settings.autoUpdateCheck) this.denetle().catch(() => {}) }
    const t1 = setTimeout(() => { tur(); const t2 = setInterval(tur, this.cfg.updateEveryMs); t2.unref?.(); this.timers.push(t2) }, this.cfg.updateFirstMs)
    t1.unref?.()
    this.timers.push(t1)
  }

  stop () { for (const t of this.timers) { clearTimeout(t); clearInterval(t) } this.timers = [] }

  denetle () {
    if (this.running) return this.running
    this.running = this._denetle().finally(() => { this.running = null })
    return this.running
  }

  async _denetle () {
    const s = this.state
    s.checkedAt = Date.now()
    const url = this.adres()
    if (!url) { s.status = 'denetlenemedi'; s.error = 'Sınama kipinde ağ kapalı'; return this.durum() }
    try {
      const r = await this.fetch(url, {
        headers: { 'User-Agent': 'stremio-offline', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000)
      })
      if (r.status === 404) { s.status = 'surum-yok'; s.error = null; s.latest = s.tag = s.url = null; return this.durum() }
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const text = await r.text()
      if (text.length > 1e6) throw new Error('yanıt çok büyük')
      const j = JSON.parse(text)
      const tag = typeof j.tag_name === 'string' ? j.tag_name.slice(0, 40) : ''
      if (!parseSurum(tag)) throw new Error('geçersiz sürüm etiketi')
      s.tag = tag
      s.latest = parseSurum(tag).join('.')
      // Yalnız https bağlantısı (arayüz yeni sekmede açar)
      s.url = typeof j.html_url === 'string' && /^https:\/\//i.test(j.html_url) ? j.html_url.slice(0, 300) : null
      s.status = karsilastir(tag, this.current) > 0 ? 'yeni' : 'guncel'
      s.error = null
      s.setup = null
      for (const a of Array.isArray(j.assets) ? j.assets : []) {
        const ad = String(a?.name || '')
        const adres = String(a?.browser_download_url || '')
        if (!KURULUM_ADI.test(ad) || !adresUygun(adres, this.izinliTum())) continue
        const dg = String(a.digest || '').toLowerCase()
        const sha = dg.startsWith('sha256:') && /^[0-9a-f]{64}$/.test(dg.slice(7)) ? dg.slice(7) : ''
        s.setup = { name: ad, url: adres, size: Number.isInteger(a.size) && a.size > 0 ? a.size : 0, sha256: sha }
        break
      }
    } catch (e) {
      // Ağ yok / zaman aşımı / bozuk yanıt: sessiz; önceki bilgi korunur, durum "denetlenemedi"
      s.status = 'denetlenemedi'
      s.error = String(e.name === 'TimeoutError' ? 'zaman aşımı' : e.message).slice(0, 120)
      log('güncelleme denetlenemedi:', s.error)
    }
    return this.durum()
  }

  /** Sınamada sahte sunucu yerel http olabilir; gerçekte yalnız GitHub https. */
  izinliTum () { return !!(this.cfg.testMode && this.cfg.updateUrl) }

  /**
   * "Şimdi güncelle": kurulum programını indirir, doğrular, başlatır, servisi kapatır.
   * Hemen döner (indirme arka planda); ilerleme durum().kurulum'da.
   */
  kur () {
    const hata = (m, status = 409) => { throw Object.assign(new Error(m), { status }) }
    if (this.kurulum.asama === 'indiriliyor' || this.kurulum.asama === 'baslatildi') hata('Güncelleme zaten sürüyor')
    if (this.state.status !== 'yeni') hata('Yeni sürüm yok')
    if (!this.kuruluMu()) hata('Bu kurulum elle yapılmış; yeni sürümü sürüm sayfasından indir')
    const st = this.state.setup
    if (!st) hata('Bu sürümde kurulum programı yok; sürüm sayfasından indir')
    if (!st.sha256) hata('Kurulum programının SHA-256 özeti yayımlanmamış; güvenlik için kurulmuyor')
    this.kurulum = { asama: 'indiriliyor', yuzde: 0, hata: null }
    log('⬆ güncelleme indiriliyor:', this.state.tag, st.name)
    this._kur(st).catch(e => {
      this.kurulum = { asama: 'hata', yuzde: 0, hata: String(e.message || e).slice(0, 200) }
      log('güncelleme kurulamadı:', this.kurulum.hata)
    })
    return this.durum()
  }

  async _kur (st) {
    const klasor = await fsp.mkdtemp(path.join(os.tmpdir(), 'StremioOffline-guncelleme-'))
    const dosya = path.join(klasor, path.basename(st.name))
    try {
      await this.indir(st, dosya)
      const p = this.calistir(dosya, KURULUM_ARGUMANLARI)
      if (p && typeof p.then === 'function') await p
      this.kurulum = { asama: 'baslatildi', yuzde: 100, hata: null }
      log('⬆ güncelleme kurulum programı başlatıldı:', this.state.tag, '- servis kapanıyor')
      // Kurulum programı servisi de kendisi durdurur; yine de dosyalar kilitli kalmasın diye kendimiz çıkarız
      if (this.cikis) setTimeout(() => this.cikis(), this.cfg.updateExitMs ?? 1500).unref?.()
    } catch (e) {
      await fsp.rm(klasor, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  }

  /** Yönlendirmeleri tek tek denetleyerek indirir; boyut ve SHA-256 tutmazsa dosya silinir, hata. */
  async indir (st, dosya) {
    const izin = this.izinliTum()
    let url = st.url
    let r
    for (let i = 0; i < 6; i++) {
      if (!adresUygun(url, izin)) throw new Error('İzin verilmeyen indirme adresi')
      r = await this.fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'stremio-offline/' + this.current, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(10 * 60 * 1000) })
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), url).href; continue }
      break
    }
    if (!r || !r.ok || !r.body) throw new Error('İndirilemedi (HTTP ' + (r?.status ?? '?') + ')')
    const toplam = st.size || Number(r.headers.get('content-length')) || 0
    const h = crypto.createHash('sha256')
    const out = fs.createWriteStream(dosya)
    let n = 0
    try {
      for await (const parca of r.body) {
        const b = Buffer.from(parca)
        n += b.length
        if (st.size && n > st.size) throw new Error('Dosya beklenenden büyük')
        h.update(b)
        if (!out.write(b)) await new Promise(res => out.once('drain', res))
        if (toplam) this.kurulum.yuzde = Math.min(99, Math.floor(n * 100 / toplam))
      }
    } finally { await new Promise(res => out.end(res)) }
    if (st.size && n !== st.size) { await fsp.rm(dosya, { force: true }); throw new Error(`Boyut tutmuyor (${n} / ${st.size})`) }
    if (h.digest('hex') !== st.sha256) { await fsp.rm(dosya, { force: true }); throw new Error('SHA-256 tutmuyor; dosya kurulmadı') }
  }
}

/** Kurulum programını servisten ayrık başlatır. Sınama kipinde program verilmediyse hiçbir şey çalıştırılmaz. */
function varsayilanCalistir (cfg) {
  return (program, args) => {
    if (cfg.updateRunner) { args = [program, ...args]; program = cfg.updateRunner } // sınama: ör. node <indirilen> /SILENT ...
    else if (cfg.testMode) throw new Error('Sınama kipinde kurulum programı çalıştırılmaz (OFFLINE_GUNCELLEME_KURUCU verilmedi)')
    return new Promise((resolve, reject) => {
      const c = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: false })
      c.once('error', reject)
      c.once('spawn', () => { c.unref(); resolve() })
    })
  }
}
