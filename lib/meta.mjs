// Cinemeta bilgisi ve görselleri yerelde saklanır (offline katalog ve sayfa için).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from './log.mjs'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export async function getJson (url, ms = 9000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

export class MetaStore {
  constructor (cfg) { this.cfg = cfg; this.inflight = new Map() }

  file (imdbId) { return path.join(this.cfg.metaDir, imdbId + '.json') }

  read (imdbId) {
    if (!/^tt\d+$/.test(imdbId || '')) return null
    try { return JSON.parse(fs.readFileSync(this.file(imdbId), 'utf8')) } catch { return null }
  }

  /** Önbellekte yoksa Cinemeta'dan alır; görselleri indirir. Hata olursa null. */
  async fetch (type, imdbId, { save = true } = {}) {
    if (!/^tt\d+$/.test(imdbId || '')) return null
    const have = this.read(imdbId)
    if (have) return have
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

  async saveImage (url, name) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
      if (!r.ok) return
      await fsp.writeFile(path.join(this.cfg.imgDir, name), Buffer.from(await r.arrayBuffer()))
    } catch {}
  }

  localImg (imdbId, kind, fallback) {
    return fs.existsSync(path.join(this.cfg.imgDir, `${imdbId}-${kind}`)) ? `${this.cfg.base}/img/${imdbId}-${kind}` : fallback
  }

  async remove (imdbId) {
    if (!/^tt\d+$/.test(imdbId || '')) return
    await fsp.rm(this.file(imdbId), { force: true }).catch(() => {})
    for (const k of ['poster', 'background', 'logo']) await fsp.rm(path.join(this.cfg.imgDir, `${imdbId}-${k}`), { force: true }).catch(() => {})
  }
}
