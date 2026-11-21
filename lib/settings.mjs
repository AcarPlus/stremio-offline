// Arayüzden değiştirilen kalıcı ayarlar: data/ayarlar.json (config.json'a dokunulmaz).
// İlk değerler config.json / ortam değişkeninden gelir (downloadLimit = OFFLINE_RATELIMIT_DOWN, uploadLimit);
// arayüzden bir kez değiştirilen değer dosyaya yazılır ve sonraki açılışlarda o geçerlidir.
import fs from 'node:fs'
import path from 'node:path'
import { LIMIT_MAX } from './engine.mjs'
import { log } from './log.mjs'
import { readJsonFile } from './jsonoku.mjs'
import { denetleKlasor } from './klasor.mjs'

export const SETTING_KEYS = ['defaultDownloadLimit', 'uploadLimit', 'priorityThrottle', 'seedLimit']

/** Bayt/sn sınır değeri: 0 = sınırsız; tam sayı, 0..LIMIT_MAX. Geçersizse null. */
export function parseLimit (v) {
  if (v === null || v === '' || v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > LIMIT_MAX) return null
  return Math.floor(n)
}

/**
 * API girişi için katı doğrulama: yalnız `typeof number`, tam sayı; 0 (sınırsız) ya da LIMIT_MIN..LIMIT_MAX bayt/sn.
 * Geçersizse null. (Dosyadan okunan değerler için gevşek parseLimit kullanılır.)
 */
export const LIMIT_MIN = 1000
export function strictLimit (v) {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null
  if (v === 0 || (v >= LIMIT_MIN && v <= LIMIT_MAX)) return v
  return null
}

export const LIMIT_ERROR = `0 (sınırsız) ya da ${LIMIT_MIN} ile ${LIMIT_MAX} arasında tam sayı bayt/sn olmalı`

const SAAT = /^([01]\d|2[0-3]):[0-5]\d$/
/**
 * Ayarlar sayfasındaki genel ayarlar (data/ayarlar.json, hız sınırlarıyla aynı dosya).
 * tip: 'int' (min..max), 'bool', 'saat' (SS:DD), 'secim' (izinli değerler). def bir işlevse cfg'den okunur.
 */
export const GENEL = {
  maxConcurrent: { tip: 'int', min: 0, max: 20, def: 0 }, // aynı anda en çok kaç indirme (0 = sınırsız); fazlası sıraya girer
  scheduleOn: { tip: 'bool', def: false }, // yalnız belirli saatlerde indir
  scheduleStart: { tip: 'saat', def: '01:00' },
  scheduleEnd: { tip: 'saat', def: '08:00' },
  minFreeGB: { tip: 'int', min: 0, max: 100000, def: 0 }, // diskte bundan az yer kalınca indirmeler durur (0 = kapalı)
  notifyOnComplete: { tip: 'bool', def: true }, // indirme bitince Windows bildirimi
  autoQuality: { tip: 'secim', degerler: ['2160p', '1080p', '720p', '480p'], def: c => ['2160p', '1080p', '720p', '480p'].includes(c.autoQuality) ? c.autoQuality : '1080p' },
  autoMaxSizeGB: { tip: 'int', min: 1, max: 1000, def: c => Number.isInteger(c.autoMaxSizeGB) && c.autoMaxSizeGB >= 1 ? Math.min(1000, c.autoMaxSizeGB) : 12 },
  preferTurkish: { tip: 'bool', def: false }, // Türkçe dublaj/altyazılı sürümleri öne al
  clipSeconds: { tip: 'secim', degerler: [30, 60, 90], def: 60 },
  clipStartPct: { tip: 'int', min: 0, max: 90, def: 30 },
  // Klip türü: video = 60 sn'lik kesit (Stremio oynatıcısında), gorsel = filmin rastgele yerlerinden birkaç sahne görseli
  // (İndirme Merkezi'nde açılır). clipImages: görsel sayısı.
  clipMode: { tip: 'secim', degerler: ['video', 'gorsel'], def: 'video' },
  clipImages: { tip: 'secim', degerler: [4, 6, 9], def: 6 },
  // İndirme bitince paylaşım (seed): kapali = süreç kapanır (yükleme yok), acik = genel yükleme sınırıyla sürer,
  // sinirli = seedLimit hızıyla sürer. Paylaşım servis ya da bilgisayar yeniden başlayınca durur (yeniden doğrulama yükü yok).
  seedMode: { tip: 'secim', degerler: ['kapali', 'acik', 'sinirli'], def: c => c.seedAfterDownload === true ? 'acik' : 'kapali' },
  showBadges: { tip: 'bool', def: true }, // Stremio posterlerinde "✓ Offline" rozeti
  deleteWatchedDays: { tip: 'int', min: 0, max: 3650, def: 0 } // son oynatılmasından X gün sonra bitmiş indirmeyi sil (0 = kapalı)
}

/** Tek bir genel ayar değerini doğrular; geçersizse null. */
export function genelDeger (k, v) {
  const t = GENEL[k]
  if (!t) return null
  if (t.tip === 'bool') return typeof v === 'boolean' ? v : null
  if (t.tip === 'int') return typeof v === 'number' && Number.isInteger(v) && v >= t.min && v <= t.max ? v : null
  if (t.tip === 'saat') return typeof v === 'string' && SAAT.test(v) ? v : null
  if (t.tip === 'secim') return t.degerler.includes(v) ? v : null
  return null
}

function genelHata (k) {
  const t = GENEL[k]
  if (t.tip === 'bool') return `${k}: true ya da false olmalı`
  if (t.tip === 'int') return `${k}: ${t.min} ile ${t.max} arasında tam sayı olmalı`
  if (t.tip === 'saat') return `${k}: SS:DD biçiminde saat olmalı (ör. 01:00)`
  return `${k}: şunlardan biri olmalı: ${t.degerler.join(', ')}`
}

export class Settings {
  constructor (cfg) {
    this.file = path.join(cfg.dataDir, 'ayarlar.json')
    const base = {
      defaultDownloadLimit: parseLimit(cfg.downloadLimit) ?? 0,
      uploadLimit: parseLimit(cfg.uploadLimit) ?? 0,
      // Öncelikli indirme varken diğer etkin indirmelerin kısıldığı hız (bayt/sn; 0 = kısma yok)
      priorityThrottle: parseLimit(cfg.priorityThrottle) ?? 200000,
      // Paylaşım (seed) "sınırlı" kipteyken bitmiş indirmelerin yükleme hızı (bayt/sn; 0 = sınırsız)
      seedLimit: parseLimit(cfg.seedLimit) ?? 100000
    }
    // BOM tolere edilir; bozuk dosya günlüğe yazılır ve ezilmeden yedeklenir (jsonoku.mjs)
    const r = readJsonFile(this.file, { what: 'ayarlar.json' })
    const saved = r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {}
    this.v = { ...base }
    for (const k of SETTING_KEYS) if (parseLimit(saved[k]) !== null) this.v[k] = parseLimit(saved[k])
    // Limit dışı kalıcı ayarlar: arayüzden seçilen indirme klasörü (yalnız yeni indirmeler için) ve otomatik güncelleme denetimi
    this.cfg = cfg
    this.autoUpdateCheck = typeof saved.autoUpdateCheck === 'boolean' ? saved.autoUpdateCheck : true
    this.g = {}
    for (const [k, t] of Object.entries(GENEL)) {
      const d = typeof t.def === 'function' ? t.def(cfg) : t.def
      this.g[k] = genelDeger(k, saved[k]) ?? d
    }
    this.userDir = null
    if (typeof saved.downloadDir === 'string' && saved.downloadDir) {
      this.userDir = saved.downloadDir
      try { this.userDir = denetleKlasor(saved.downloadDir, { programlar: [cfg.rqbitExe] }); cfg.downloadDir = this.userDir } catch (e) {
        // Kayıtlı klasör artık kullanılamıyor (sürücü çıkarıldı vb.): config.json/varsayılana dönülür, dosyadaki değer ezilmez
        log('kayıtlı indirme klasörü kullanılamıyor, varsayılan kullanılıyor:', saved.downloadDir, '-', e.message)
      }
    }
  }

  /** Yalnız hız sınırları (yöneticinin kullandığı). */
  get () { return { ...this.v } }

  /** Genel ayarlar (GENEL anahtarları). */
  genel () { return { ...this.g } }

  /** Hız sınırları + indirme klasörü + otomatik güncelleme denetimi + genel ayarlar (GET /api/settings). */
  all () { return { ...this.v, downloadDir: this.cfg.downloadDir, autoUpdateCheck: this.autoUpdateCheck, ...this.g } }

  /** Önce bütün alanlar doğrulanır, sonra uygulanır (geçersiz alan varsa hiçbiri uygulanmaz); değişen anahtarlar döner. */
  set (patch) {
    const next = {}
    for (const k of SETTING_KEYS) {
      if (!(k in patch)) continue
      const n = strictLimit(patch[k])
      if (n === null) throw Object.assign(new Error(`${k}: ${LIMIT_ERROR}`), { status: 400 })
      next[k] = n
    }
    let dir = null
    if ('downloadDir' in patch) dir = denetleKlasor(patch.downloadDir, { programlar: [this.cfg.rqbitExe] }) // hata: 400, hiçbir şey uygulanmaz
    if ('autoUpdateCheck' in patch && typeof patch.autoUpdateCheck !== 'boolean') throw Object.assign(new Error('autoUpdateCheck: true ya da false olmalı'), { status: 400 })
    const nextG = {}
    for (const k of Object.keys(GENEL)) {
      if (!(k in patch)) continue
      const v = genelDeger(k, patch[k])
      if (v === null) throw Object.assign(new Error(genelHata(k)), { status: 400 })
      nextG[k] = v
    }
    const changed = []
    for (const [k, v] of Object.entries(nextG)) if (this.g[k] !== v) { this.g[k] = v; changed.push(k) }
    for (const [k, n] of Object.entries(next)) if (this.v[k] !== n) { this.v[k] = n; changed.push(k) }
    let write = false
    if (dir !== null && (dir !== this.cfg.downloadDir || this.userDir !== dir)) {
      if (dir !== this.cfg.downloadDir) changed.push('downloadDir')
      this.cfg.downloadDir = dir
      this.userDir = dir
      write = true
    }
    if ('autoUpdateCheck' in patch && patch.autoUpdateCheck !== this.autoUpdateCheck) { this.autoUpdateCheck = patch.autoUpdateCheck; changed.push('autoUpdateCheck') }
    if (changed.length || write) {
      const out = { ...this.v, autoUpdateCheck: this.autoUpdateCheck, ...this.g }
      if (this.userDir) out.downloadDir = this.userDir
      try {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(out, null, 2))
        fs.renameSync(this.file + '.tmp', this.file)
      } catch (e) { log('ayarlar yazılamadı:', e.message) }
    }
    return changed
  }
}
