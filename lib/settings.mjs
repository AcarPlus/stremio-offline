// Arayüzden değiştirilen kalıcı ayarlar: data/ayarlar.json (config.json'a dokunulmaz).
// İlk değerler config.json / ortam değişkeninden gelir (downloadLimit = OFFLINE_RATELIMIT_DOWN, uploadLimit);
// arayüzden bir kez değiştirilen değer dosyaya yazılır ve sonraki açılışlarda o geçerlidir.
import fs from 'node:fs'
import path from 'node:path'
import { LIMIT_MAX } from './engine.mjs'
import { log } from './log.mjs'

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
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {} } catch {}
    this.v = { ...base }
    for (const k of SETTING_KEYS) if (parseLimit(saved[k]) !== null) this.v[k] = parseLimit(saved[k])
  }

  get () { return { ...this.v } }

  /** Önce bütün alanlar doğrulanır, sonra uygulanır (geçersiz alan varsa hiçbiri uygulanmaz); değişen anahtarlar döner. */
  set (patch) {
    const next = {}
    for (const k of SETTING_KEYS) {
      if (!(k in patch)) continue
      const n = strictLimit(patch[k])
      if (n === null) throw Object.assign(new Error(`${k}: ${LIMIT_ERROR}`), { status: 400 })
      next[k] = n
    }
    const changed = []
    for (const [k, n] of Object.entries(next)) if (this.v[k] !== n) { this.v[k] = n; changed.push(k) }
    if (changed.length) {
      try {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.v, null, 2))
        fs.renameSync(this.file + '.tmp', this.file)
      } catch (e) { log('ayarlar yazılamadı:', e.message) }
    }
    return changed
  }
}
