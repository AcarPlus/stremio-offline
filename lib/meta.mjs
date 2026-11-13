// Cinemeta bilgisi ve görselleri yerelde saklanır (offline katalog ve sayfa için).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from './log.mjs'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

/** JSON GET; geçici hatada (ağ hatası, zaman aşımı, 5xx) bir kez daha dener. */
export async function getJson (url, ms = 9000, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) })
      if (!r.ok) {
        const e = new Error(`${r.status} ${url}`)
        e.transient = r.status >= 500
        throw e
      }
      return await r.json()
    } catch (e) {
      const transient = e.transient !== false && !(e instanceof SyntaxError)
      if (attempt >= retries || !transient) throw e
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
}

export class MetaStore {
  constructor (cfg) { this.cfg = cfg; this.inflight = new Map(); this.imgTried = new Map() }

  file (imdbId) { return path.join(this.cfg.metaDir, imdbId + '.json') }

  read (imdbId) {
    if (!/^tt\d+$/.test(imdbId || '')) return null
    try { return JSON.parse(fs.readFileSync(this.file(imdbId), 'utf8')) } catch { return null }
  }

  /** Önbellekte yoksa Cinemeta'dan alır; görselleri indirir. Hata olursa null. */
  async fetch (type, imdbId, { save = true } = {}) {
    if (!/^tt\d+$/.test(imdbId || '')) return null
    const have = this.read(imdbId)
    if (have) {
      if (save) await this.fillImages(imdbId, have)
      return have
    }
    const key = type + imdbId
    if (this.inflight.has(key)) return this.inflight.get(key)
    const p = (async () => {
      try {
        const meta = (await getJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`)).meta
        if (!meta) return null
        if (save) {
          await fsp.writeFile(this.file(imdbId), JSON.stringify(meta))
          for (const k of ['poster', 'background', 'logo']) if (meta[k]) await this.saveImage(meta[k], `${imdbId}-${k}`)
        }
        return meta
      } catch (e) { log('meta alınamadı:', imdbId, e.message); return null } finally { this.inflight.delete(key) }
    })()
    this.inflight.set(key, p)
    return p
  }

  /** Meta JSON'u var ama görseller eksikse yalnızca eksikleri yeniden indirir (aynı görsel için 10 dk'da bir). */
  async fillImages (imdbId, meta) {
    for (const k of ['poster', 'background', 'logo']) {
      const name = `${imdbId}-${k}`
      if (!meta[k] || fs.existsSync(path.join(this.cfg.imgDir, name))) continue
      if (Date.now() - (this.imgTried.get(name) || 0) < 10 * 60 * 1000) continue
      this.imgTried.set(name, Date.now())
      await this.saveImage(meta[k], name)
    }
  }

  async saveImage (url, name) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
      if (!r.ok) return false
      await fsp.writeFile(path.join(this.cfg.imgDir, name), Buffer.from(await r.arrayBuffer()))
      return true
    } catch { return false }
  }

  localImg (imdbId, kind, fallback) {
    return fs.existsSync(path.join(this.cfg.imgDir, `${imdbId}-${kind}`)) ? `${this.cfg.base}/img/${imdbId}-${kind}` : fallback
  }

  /** inUse() true dönerse (kaldırılırken aynı içerik yeniden eklendi) hiçbir şey silinmez. */
  async remove (imdbId, inUse = () => false) {
    if (!/^tt\d+$/.test(imdbId || '')) return
    if (inUse()) return
    await fsp.rm(this.file(imdbId), { force: true }).catch(() => {})
    for (const k of ['poster', 'background', 'logo']) {
      if (inUse()) return
      await fsp.rm(path.join(this.cfg.imgDir, `${imdbId}-${k}`), { force: true }).catch(() => {})
    }
  }
}
