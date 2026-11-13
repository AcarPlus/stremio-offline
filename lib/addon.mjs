// Stremio eklenti uçları: manifest, stream, catalog, meta.
import { log } from './log.mjs'

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f1b3a"/><path d="M32 12v26m0 0-11-11m11 11 11-11M16 48h32" fill="none" stroke="#9d8cff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const fmtSize = n => !n ? '' : n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(0) + ' MB'
const hints = fileName => ({ notWebReady: !/\.mp4$/i.test(fileName || ''), ...(fileName ? { filename: fileName } : {}) })

export class Addon {
  constructor ({ cfg, manager, torrentio, meta }) {
    this.cfg = cfg
    this.manager = manager
    this.torrentio = torrentio
    this.meta = meta
    this.logo = LOGO
  }

  manifest () {
    return {
      id: 'local.stremio.offline-indir',
      version: '1.1.0',
      name: 'Offline İndir',
      description: 'Torrentio sonuçlarını tek tıkla cihaza indirir ve indirirken oynatır. İnenler internetsiz izlenir.',
      logo: `${this.cfg.base}/logo.svg`,
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      resources: ['stream', 'catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
      catalogs: [
        { type: 'movie', id: 'offline-movies', name: 'İndirilenler' },
        { type: 'series', id: 'offline-series', name: 'İndirilenler' }
      ],
      behaviorHints: { configurable: false }
    }
  }

  playUrl (type, id, infoHash, fileIdx) {
    return `${this.cfg.base}/play/${type}/${encodeURIComponent(id)}/${infoHash}/${Number.isInteger(fileIdx) ? fileIdx : 'x'}`
  }

  /** Kütüphanedeki bu kimliğe ait dosyalar (+ istenirse Torrentio'dan "İndir+Oynat" satırları). */
  async streams (type, id) {
    const streams = []
    const have = new Set()
    for (const item of this.manager.lib.all()) {
      for (const f of item.files || []) {
        const match = f.videoId === id || (type === 'movie' && item.imdbId === id && f.videoId === id)
        if (!match || !f.selected) continue
        have.add(`${item.infoHash}:${f.idx}`)
        if (f.idx == null) have.add(item.infoHash) // eski kayıt: dosya numarası bilinmiyor, torrentin tamamını say
        const done = this.manager.fileOnDisk(f)
        const pct = f.length ? Math.floor(Math.min(1, f.progressBytes / f.length) * 100) : 0
        const label = done ? '💾 Offline\nHazır'
          : item.state === 'paused' ? `⏸ Duraklatıldı\n%${pct}`
            : item.state === 'error' ? '⚠ Hata\nyeniden dener'
              : `⏬ İniyor\n%${pct}`
        streams.push({
          name: label,
          description: `${f.name || item.name || item.title || ''}\n${fmtSize(f.length)}${done ? ' · internetsiz oynar' : ' · izlerken inmeye devam eder'}`,
          url: this.playUrl(type, id, item.infoHash, f.idx),
          behaviorHints: hints(f.name)
        })
      }
    }
    if (!this.cfg.showDownloadRows) return { streams }
    try {
      for (const v of await this.torrentio.versions(type, id)) {
        if (have.has(`${v.infoHash}:${v.fileIdx ?? 'x'}`) || have.has(v.infoHash)) continue
        streams.push({
          name: `⬇ İndir+Oynat\n${v.quality}`.trim(),
          description: v.title,
          url: this.playUrl(type, id, v.infoHash, v.fileIdx),
          behaviorHints: hints(v.fileName)
        })
      }
    } catch (e) {
      if (!streams.length) log('Torrentio yanıt vermedi (offline olabilir):', e.message)
    }
    return { streams }
  }

  catalog (type) {
    const seen = new Map()
    for (const item of this.manager.lib.all().sort((a, b) => b.addedAt - a.addedAt)) {
      if (item.type !== type || !item.imdbId || seen.has(item.imdbId)) continue
      const meta = this.meta.read(item.imdbId)
      seen.set(item.imdbId, {
        id: item.imdbId,
        type,
        name: meta?.name || item.displayName || item.name || item.imdbId,
        poster: this.meta.localImg(item.imdbId, 'poster', meta?.poster),
        posterShape: 'poster',
        description: meta?.description,
        releaseInfo: meta?.releaseInfo
      })
    }
    return { metas: [...seen.values()] }
  }

  metaFor (type, imdbId) {
    const items = this.manager.lib.all().filter(i => i.imdbId === imdbId)
    const meta = items.length && this.meta.read(imdbId)
    if (!meta) return null
    meta.poster = this.meta.localImg(imdbId, 'poster', meta.poster)
    meta.background = this.meta.localImg(imdbId, 'background', meta.background)
    meta.logo = this.meta.localImg(imdbId, 'logo', meta.logo)
    if (type === 'series' && Array.isArray(meta.videos)) {
      const ids = new Set(items.flatMap(i => (i.files || []).filter(f => f.selected && f.videoId).map(f => f.videoId)))
      meta.videos = meta.videos.filter(v => ids.has(v.id)).map(v => ({ ...v, thumbnail: undefined }))
    }
    return { meta }
  }
}
