// Güncelleme denetimi: package.json sürümü ile GitHub son sürümü (releases/latest) karşılaştırılır.
// Otomatik indirme/kurma YOK; yalnızca "yeni sürüm var" bilgisi ve sürüm sayfası bağlantısı.
// Ağ yoksa / depo yayında değilse (404) sessiz kalınır. Sınama: OFFLINE_GUNCELLEME_URL ile yerel sahte sunucu;
// sınama kipinde bu değişken yoksa ağa hiç çıkılmaz.
import fs from 'node:fs'
import path from 'node:path'
import { log } from './log.mjs'

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
  constructor ({ cfg, settings, fetchFn = fetch }) {
    this.cfg = cfg
    this.settings = settings
    this.fetch = fetchFn
    let cur = '0.0.0'
    try { cur = JSON.parse(fs.readFileSync(path.join(cfg.root, 'package.json'), 'utf8')).version || cur } catch {}
    this.current = cur
    this.state = { status: 'hic', latest: null, tag: null, url: null, checkedAt: null, error: null }
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
      repo: this.cfg.updateRepo
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
    } catch (e) {
      // Ağ yok / zaman aşımı / bozuk yanıt: sessiz; önceki bilgi korunur, durum "denetlenemedi"
      s.status = 'denetlenemedi'
      s.error = String(e.name === 'TimeoutError' ? 'zaman aşımı' : e.message).slice(0, 120)
      log('güncelleme denetlenemedi:', s.error)
    }
    return this.durum()
  }
}
