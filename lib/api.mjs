// Arayüz API'si (/api/...). Ayrıntılı belge: docs/api.md
import { UserError } from './manager.mjs'
import { getJson } from './meta.mjs'

export function readBody (req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let d = ''
    req.setEncoding('utf8')
    req.on('data', c => { d += c; if (d.length > limit) { reject(new UserError('istek çok büyük', 413)); req.destroy() } })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { reject(new UserError('geçersiz JSON')) } })
    req.on('error', reject)
  })
}

const shortName = v => v.displayName || v.name || 'içerik'

export class Api {
  constructor ({ cfg, manager, torrentio }) {
    this.cfg = cfg
    this.manager = manager
    this.torrentio = torrentio
    this.searchCache = new Map()
  }

  /** Eski menü düğmesi (inject.js): belirli bir akışı indir. */
  async legacyDownload (b) {
    const infoHash = String(b.infoHash || '').toLowerCase()
    if (!/^[a-f0-9]{40}$/.test(infoHash)) throw new UserError('Bu akış torrent değil, indirilemez')
    if (!['movie', 'series'].includes(b.type) || !/^tt\d+/.test(b.id || '')) throw new UserError('Bu içerik türü desteklenmiyor')
    const fileIdx = Number.isInteger(b.fileIdx) ? b.fileIdx : null
    const known = this.torrentio.lookup(infoHash)
    const trackers = [...(Array.isArray(b.trackers) ? b.trackers : []), ...(known?.trackers || [])]
    const { item, existed } = this.manager.add({
      infoHash, files: fileIdx != null ? [fileIdx] : null, trackers, type: b.type, id: b.id,
      title: String(b.title || known?.name || ''),
      source: known ? pickSource(known) : { title: String(b.title || '') }
    })
    const v = this.manager.view(item)
    if (existed) {
      const f = this.manager.pickFile(item, fileIdx, b.id)
      if (f && this.manager.fileOnDisk(f)) return { ok: true, state: 'completed', message: `Zaten indirilmiş: ${shortName(v)}`, item: v }
      if (item.state === 'paused' || item.state === 'error') {
        await this.manager.resume(item.infoHash)
        return { ok: true, state: 'downloading', message: `İndirme sürdürüldü: ${shortName(v)}`, item: this.manager.view(item) }
      }
      return { ok: true, state: item.state, message: `Zaten iniyor (%${Math.floor(v.percent)}): ${shortName(v)}`, item: v }
    }
    return { ok: true, state: 'downloading', message: `İndirme başladı: ${shortName(v) === 'içerik' ? (b.fileName || 'içerik') : shortName(v)}`, item: v }
  }

  /** Kart menüsü: sürümü kendisi seçer (ayarlardaki kalite, boyut sınırı, en çok kaynak). */
  async legacyAuto (b) {
    if (!['movie', 'series'].includes(b.type) || !/^tt\d+/.test(b.id || '')) throw new UserError('Bu içerik türü desteklenmiyor')
    const existing = this.manager.lib.all().find(i => (i.files || []).some(f => f.selected && f.videoId === b.id) || (b.type === 'movie' && i.imdbId === b.id))
    if (existing) {
      const v = this.manager.view(existing)
      if (existing.state === 'completed') return { ok: true, state: 'completed', message: `Zaten indirilmiş: ${shortName(v)}`, item: v }
      if (existing.state === 'paused' || existing.state === 'error') {
        await this.manager.resume(existing.infoHash)
        return { ok: true, state: 'downloading', message: `İndirme sürdürüldü: ${shortName(v)}`, item: this.manager.view(existing) }
      }
      return { ok: true, state: existing.state, message: `Zaten iniyor (%${Math.floor(v.percent)}): ${shortName(v)}`, item: v }
    }
    const list = (await this.torrentio.versions(b.type, b.id)).filter(t => t.seeders > 0)
    if (!list.length) throw new UserError('Kaynağı olan bir torrent bulunamadı')
    const max = this.cfg.autoMaxSizeGB
    const fits = t => !t.sizeGB || t.sizeGB <= max
    const bySeed = (a, c) => c.seeders - a.seeders
    const pick = list.filter(t => t.quality.includes(this.cfg.autoQuality) && fits(t)).sort(bySeed)[0] ||
      list.filter(fits).sort(bySeed)[0] || [...list].sort(bySeed)[0]
    const { item } = this.manager.add({
      infoHash: pick.infoHash, files: pick.fileIdx != null ? [pick.fileIdx] : null, trackers: pick.trackers,
      type: b.type, id: b.id, title: pick.title, source: pickSource(pick)
    })
    return { ok: true, state: 'downloading', message: `İndirme başladı: ${pick.quality || '?'} · ${pick.sizeGB ? pick.sizeGB.toFixed(1) + ' GB' : '?'} · 👤 ${pick.seeders}`, item: this.manager.view(item) }
  }

  /** GET /api/search?q=… → { q, results: [{ type, id, name, year, poster }] } (film + dizi) */
  async search (q) {
    q = String(q || '').trim().slice(0, 80)
    if (q.length < 2) throw new UserError('Arama için en az 2 karakter yaz')
    const key = q.toLowerCase()
    const hit = this.searchCache.get(key)
    if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.v
    const one = async type => {
      const r = await getJson(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`)
      return (r.metas || []).filter(x => /^tt[0-9]+$/.test(x.id || ''))
        .map(x => ({ x, hit: String(x.name || '').toLowerCase().includes(key) ? 0 : 1 })).sort((p, r) => p.hit - r.hit).slice(0, 15).map(({ x }) => x)
        .map(x => ({ type, id: x.id, name: x.name || x.id, year: x.releaseInfo || (x.year ? String(x.year) : ''), poster: x.poster || '' }))
    }
    const [a, b] = await Promise.allSettled([one('movie'), one('series')])
    if (a.status === 'rejected' && b.status === 'rejected') throw new UserError('Arama servisine ulaşılamadı (internet var mı?)', 502)
    const v = { q, results: [...(a.value || []), ...(b.value || [])] }
    this.searchCache.set(key, { t: Date.now(), v })
    if (this.searchCache.size > 100) this.searchCache.delete(this.searchCache.keys().next().value)
    return v
  }

  /** GET /api/title?type=&id= → { type, id, name, year, poster, description, seasons: [{ season, episodes }] } */
  async title (type, id) {
    if (!['movie', 'series'].includes(type) || !/^tt[0-9]+$/.test(id || '')) throw new UserError('type (movie|series) ve id (tt…) gerekli')
    const meta = await this.manager.meta.fetch(type, id, { save: false })
    if (!meta) throw new UserError('Başlık bilgisi alınamadı', 502)
    const bySeason = new Map()
    for (const v of meta.videos || []) if (Number.isInteger(v.season)) bySeason.set(v.season, (bySeason.get(v.season) || 0) + 1)
    return {
      type, id, name: meta.name || id, year: meta.releaseInfo || meta.year || '', poster: meta.poster || '', description: meta.description || '',
      seasons: [...bySeason].sort((x, y) => x[0] - y[0]).map(([season, episodes]) => ({ season, episodes }))
    }
  }

  /** parts: ['api', ...]; dönüş: [durum, gövde] */
  async handle (req, parts, url) {
    const m = req.method
    const [, a, b, c] = parts
    const M = this.manager

    if (a === 'download' && m === 'POST') return [200, await this.legacyDownload(await readBody(req))]
    if (a === 'auto' && m === 'POST') return [200, await this.legacyAuto(await readBody(req))]
    if (a === 'status' && m === 'GET') return [200, await M.summary()]

    if (a === 'items') {
      if (!b) {
        if (m === 'GET') return [200, { summary: await M.summary(), items: M.lib.all().sort((x, y) => y.addedAt - x.addedAt).map(i => M.view(i)) }]
        if (m === 'POST') {
          const body = await readBody(req)
          const known = body.infoHash ? this.torrentio.lookup(body.infoHash) : null
          const { item, existed } = M.add({
            ...body,
            trackers: [...(body.trackers || []), ...(known?.trackers || [])],
            title: body.title || known?.name || '',
            source: body.source || (known ? pickSource(known) : undefined)
          })
          return [existed ? 200 : 201, { existed, item: M.view(item) }]
        }
      } else {
        const ih = b.toLowerCase()
        if (!c && m === 'GET') return [200, M.view(M.get(ih))]
        if ((!c && m === 'DELETE') || (c === 'delete' && m === 'POST')) {
          const keep = /^(1|true|yes)$/i.test(url.searchParams.get('keepFiles') || '')
          return [200, { ok: await M.remove(ih, { keepFiles: keep }) }]
        }
        if (m === 'POST') {
          if (c === 'pause') return [200, M.view(await M.pause(ih))]
          if (c === 'resume') return [200, M.view(await M.resume(ih))]
          if (c === 'cancel') return [200, { ok: await M.cancel(ih) }]
          if (c === 'files') {
            const body = await readBody(req)
            if (!Array.isArray(body.files)) throw new UserError('files dizisi gerekli')
            return [200, M.view(await M.select(ih, body.files))]
          }
        }
      }
    }

    if (a === 'versions' && m === 'GET') {
      const type = url.searchParams.get('type')
      const id = url.searchParams.get('id') || ''
      if (!['movie', 'series'].includes(type) || !/^tt\d+(:\d+:\d+)?$/.test(id)) throw new UserError('type (movie|series) ve id (tt… ya da tt…:sezon:bölüm) gerekli')
      const versions = await this.torrentio.versions(type, id)
      return [200, { type, id, versions: versions.map(v => withLibrary(M, v)) }]
    }

    if (a === 'season' && m === 'GET') {
      const id = (url.searchParams.get('id') || '').split(':')[0]
      const season = Number(url.searchParams.get('season'))
      if (!/^tt\d+$/.test(id) || !Number.isInteger(season) || season < 0) throw new UserError('id (tt…) ve season gerekli')
      const r = await this.torrentio.season(id, season)
      r.packs = r.packs.map(p => withLibrary(M, p))
      r.episodes = r.episodes.map(e => ({ ...e, options: e.options.map(v => withLibrary(M, v)) }))
      return [200, r]
    }

    if (a === 'torrents' && b && c === 'files' && m === 'GET') {
      const known = this.torrentio.lookup(b)
      const season = url.searchParams.get('season')
      return [200, await M.torrentFiles(b, { trackers: known?.trackers || [], season: season != null && season !== '' ? +season : null })]
    }

    // Başlık arama (İndirme Merkezi'nin arama kutusu): Cinemeta'nın herkese açık arama kataloğu
    if (a === 'search' && m === 'GET') return [200, await this.search(url.searchParams.get('q'))]
    if (a === 'title' && m === 'GET') return [200, await this.title(url.searchParams.get('type'), url.searchParams.get('id'))]

    // Eski panel uçları
    if (a === 'library' && m === 'GET') return [200, { downloadDir: this.cfg.downloadDir, items: M.lib.all().map(i => M.view(i)) }]
    if (a === 'delete' && m === 'POST') {
      const key = String(url.searchParams.get('key') || '').split(':')[0]
      return [200, { ok: await M.remove(key, { keepFiles: false }) }]
    }
    return [404, { err: 'yok' }]
  }
}

function pickSource (v) {
  return { title: v.title, quality: v.quality, sizeGB: v.sizeGB, seeders: v.seeders, site: v.source, languages: v.languages, languageText: v.languageText }
}

/** Sürüm nesnesine kütüphanedeki durumu ekler. */
function withLibrary (M, v) {
  const item = M.lib.get(v.infoHash)
  if (!item) return { ...v, library: null }
  const f = v.fileIdx != null ? item.files.find(x => x.idx === v.fileIdx) : null
  return { ...v, library: { state: item.state, fileSelected: f ? !!f.selected : null, fileComplete: f ? M.fileOnDisk(f) : null } }
}
