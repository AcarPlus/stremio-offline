// Arayüzden değiştirilen kalıcı ayarlar: data/ayarlar.json (config.json'a dokunulmaz).
// İlk değerler config.json / ortam değişkeninden gelir (downloadLimit = OFFLINE_RATELIMIT_DOWN, uploadLimit);
// arayüzden bir kez değiştirilen değer dosyaya yazılır ve sonraki açılışlarda o geçerlidir.
import fs from 'node:fs'
import path from 'node:path'
import { LIMIT_MAX } from './engine.mjs'
import { log } from './log.mjs'
import { readJsonFile } from './jsonoku.mjs'
import { denetleKlasor } from './klasor.mjs'

export const SETTING_KEYS = ['defaultDownloadLimit', 'uploadLimit', 'priorityThrottle']

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

export class Settings {
  constructor (cfg) {
    this.file = path.join(cfg.dataDir, 'ayarlar.json')
    const base = {
      defaultDownloadLimit: parseLimit(cfg.downloadLimit) ?? 0,
      uploadLimit: parseLimit(cfg.uploadLimit) ?? 0,
      // Öncelikli indirme varken diğer etkin indirmelerin kısıldığı hız (bayt/sn; 0 = kısma yok)
      priorityThrottle: parseLimit(cfg.priorityThrottle) ?? 200000
    }
    // BOM tolere edilir; bozuk dosya günlüğe yazılır ve ezilmeden yedeklenir (jsonoku.mjs)
    const r = readJsonFile(this.file, { what: 'ayarlar.json' })
    const saved = r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {}
    this.v = { ...base }
    for (const k of SETTING_KEYS) if (parseLimit(saved[k]) !== null) this.v[k] = parseLimit(saved[k])
    // Limit dışı kalıcı ayarlar: arayüzden seçilen indirme klasörü (yalnız yeni indirmeler için) ve otomatik güncelleme denetimi
    this.cfg = cfg
    this.autoUpdateCheck = typeof saved.autoUpdateCheck === 'boolean' ? saved.autoUpdateCheck : true
    this.userDir = null
    if (typeof saved.downloadDir === 'string' && saved.downloadDir) {
      this.userDir = saved.downloadDir
      try { this.userDir = denetleKlasor(saved.downloadDir); cfg.downloadDir = this.userDir } catch (e) {
        // Kayıtlı klasör artık kullanılamıyor (sürücü çıkarıldı vb.): config.json/varsayılana dönülür, dosyadaki değer ezilmez
        log('kayıtlı indirme klasörü kullanılamıyor, varsayılan kullanılıyor:', saved.downloadDir, '-', e.message)
      }
    }
  }

  /** Yalnız hız sınırları (yöneticinin kullandığı). */
  get () { return { ...this.v } }

  /** Hız sınırları + indirme klasörü + otomatik güncelleme denetimi (GET /api/settings). */
  all () { return { ...this.v, downloadDir: this.cfg.downloadDir, autoUpdateCheck: this.autoUpdateCheck } }

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
    if ('downloadDir' in patch) dir = denetleKlasor(patch.downloadDir) // hata: 400, hiçbir şey uygulanmaz
    if ('autoUpdateCheck' in patch && typeof patch.autoUpdateCheck !== 'boolean') throw Object.assign(new Error('autoUpdateCheck: true ya da false olmalı'), { status: 400 })
    const changed = []
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
      const out = { ...this.v, autoUpdateCheck: this.autoUpdateCheck }
      if (this.userDir) out.downloadDir = this.userDir
      try {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(out, null, 2))
        fs.renameSync(this.file + '.tmp', this.file)
      } catch (e) { log('ayarlar yazılamadı:', e.message) }
    }
    return changed
  }
}
