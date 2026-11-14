// Arayüzden değiştirilen kalıcı ayarlar: data/ayarlar.json (config.json'a dokunulmaz).
// İlk değerler config.json / ortam değişkeninden gelir (downloadLimit = OFFLINE_RATELIMIT_DOWN, uploadLimit);
// arayüzden bir kez değiştirilen değer dosyaya yazılır ve sonraki açılışlarda o geçerlidir.
import fs from 'node:fs'
import path from 'node:path'
import { LIMIT_MAX } from './engine.mjs'
import { log } from './log.mjs'

export const SETTING_KEYS = ['defaultDownloadLimit', 'uploadLimit']

/** Bayt/sn sınır değeri: 0 = sınırsız; tam sayı, 0..LIMIT_MAX. Geçersizse null. */
export function parseLimit (v) {
  if (v === null || v === '' || v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > LIMIT_MAX) return null
  return Math.floor(n)
}

export class Settings {
  constructor (cfg) {
    this.file = path.join(cfg.dataDir, 'ayarlar.json')
    const base = {
      defaultDownloadLimit: parseLimit(cfg.downloadLimit) ?? 0,
      uploadLimit: parseLimit(cfg.uploadLimit) ?? 0
    }
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {} } catch {}
    this.v = { ...base }
    for (const k of SETTING_KEYS) if (parseLimit(saved[k]) !== null) this.v[k] = parseLimit(saved[k])
  }

  get () { return { ...this.v } }

  /** patch içindeki geçerli anahtarları yazar; değişen anahtarların listesini döndürür. */
  set (patch) {
    const changed = []
    for (const k of SETTING_KEYS) {
      if (!(k in patch)) continue
      const n = parseLimit(patch[k])
      if (n === null) throw Object.assign(new Error(`${k}: 0 (sınırsız) ile ${LIMIT_MAX} arasında bayt/sn değeri olmalı`), { status: 400 })
      if (this.v[k] !== n) { this.v[k] = n; changed.push(k) }
    }
    if (changed.length) {
      try {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.v, null, 2))
        fs.renameSync(this.file + '.tmp', this.file)
      } catch (e) { log('ayarlar yazılamadı:', e.message) }
    }
    return changed
  }
}
