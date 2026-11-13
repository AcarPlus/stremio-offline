// Torrentio katmanı: film/bölüm için sürüm listesi; sezon için paket torrentleri ve
// bölüm bölüm seçenekler. Torrentio'nun "title" metni çözümlenir:
//   "Torrent adı\n[klasör/]Dosya adı\n👤 86 💾 7.61 GB ⚙️ ThePirateBay\nMulti Audio / 🇬🇧 / 🇮🇹"
// (tek dosyalı torrentte ikinci satır yoktur). 💾 değeri torrentin toplam boyutudur.
import { parseEpisode } from './episodes.mjs'
import { getJson } from './meta.mjs'

const CACHE_MS = 10 * 60 * 1000

/** Bayrak emojisi -> ülke kodu ("🇬🇧" -> "gb") */
function flagToCode (flag) {
  const cps = [...flag].map(c => c.codePointAt(0))
  if (cps.length !== 2 || cps.some(c => c < 0x1f1e6 || c > 0x1f1ff)) return null
  return cps.map(c => String.fromCharCode(c - 0x1f1e6 + 97)).join('')
}

export function parseSize (text) {
  const m = /💾\s*([\d.,]+)\s*(TB|GB|MB|KB)/i.exec(text || '')
  if (!m) return 0
  const n = parseFloat(m[1].replace(',', '.'))
  return Math.round(n * { TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3 }[m[2].toUpperCase()])
}

/** Tek bir Torrentio akışını sürüm nesnesine çevirir. */
export function parseStream (s, type, id) {
  if (!s || !/^[a-f0-9]{40}$/i.test(s.infoHash || '')) return null
  const text = String(s.title || s.description || '')
  const lines = text.split('\n')
  const statsIdx = lines.findIndex(l => l.includes('👤') || l.includes('💾') || l.includes('⚙️'))
  const statsLine = statsIdx >= 0 ? lines[statsIdx] : ''
  const torrentName = (statsIdx === 0 ? '' : lines[0]) || s.behaviorHints?.filename || ''
  const filePath = statsIdx >= 2 ? lines.slice(1, statsIdx).join(' ') : ''
  const fileName = s.behaviorHints?.filename || (filePath ? filePath.split('/').pop() : torrentName)
  const langLine = statsIdx >= 0 && statsIdx < lines.length - 1 ? lines.slice(statsIdx + 1).join(' / ') : ''
  const langParts = langLine.split('/').map(x => x.trim()).filter(Boolean)
  const languages = []; const languageTags = []
  for (const p of langParts) { const c = flagToCode(p); c ? languages.push(c) : languageTags.push(p) }
  const nameLines = String(s.name || '').split('\n')
  const quality = nameLines.slice(1).join(' ').trim()
  const tags = []
  const all = torrentName + ' ' + fileName
  if (/\bHDR10\+?|\bHDR\b/i.test(all)) tags.push('HDR')
  if (/\b(DV|DoVi|Dolby[ .]?Vision)\b/i.test(all)) tags.push('DV')
  if (/\b(x265|HEVC|H\.?265)\b/i.test(all)) tags.push('HEVC')
  if (/\bREMUX\b/i.test(all)) tags.push('REMUX')
  if (/\b(CAM|HDCAM|TS|TELESYNC)\b/.test(all)) tags.push('CAM')
  let kind = 'single'
  if (type === 'series') {
    const ep = parseEpisode(torrentName)
    kind = ep ? 'episode' : 'pack'
  } else if (statsIdx >= 2) kind = 'collection'
  const sizeBytes = parseSize(statsLine)
  return {
    infoHash: s.infoHash.toLowerCase(),
    fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
    name: torrentName,
    fileName,
    quality,
    tags,
    sizeBytes,
    sizeGB: sizeBytes ? Math.round(sizeBytes / 1e7) / 100 : null,
    seeders: +(/👤\s*(\d+)/.exec(statsLine)?.[1] || 0),
    source: (/⚙️\s*(.+)$/.exec(statsLine)?.[1] || '').trim(),
    languages,
    languageTags,
    languageText: langLine,
    trackers: (s.sources || []).filter(x => typeof x === 'string' && x.startsWith('tracker:')).map(x => x.slice(8)),
    kind,
    type,
    id,
    title: text
  }
}

export class Torrentio {
  constructor (cfg, meta) {
    this.cfg = cfg
    this.meta = meta
    this.cache = new Map() // url -> { at, data }
    this.known = new Map() // infoHash -> son görülen sürüm (tracker'lar, ad)
  }

  base () { return this.cfg.torrentioUrl.replace(/\/+$/, '') }

  async raw (type, id) {
    const url = `${this.base()}/stream/${type}/${encodeURIComponent(id)}.json`
    const c = this.cache.get(url)
    if (c && Date.now() - c.at < CACHE_MS) return c.data
    const data = await getJson(url, 12000)
    this.cache.set(url, { at: Date.now(), data })
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value)
    return data
  }

  /** Film ya da bölüm için sürümler (seeder'a göre azalan). */
  async versions (type, id) {
    const data = await this.raw(type, id)
    const out = []
    for (const s of data.streams || []) {
      const v = parseStream(s, type, id)
      if (!v) continue
      const k = this.known.get(v.infoHash)
      this.known.set(v.infoHash, { ...k, ...v, trackers: [...new Set([...(k?.trackers || []), ...v.trackers])] })
      out.push(v)
    }
    out.sort((a, b) => b.seeders - a.seeders)
    return out
  }

  lookup (infoHash) { return this.known.get(String(infoHash).toLowerCase()) || null }

  /**
   * Sezon: paket torrentleri ve bölüm bölüm seçenekler.
   * Bölüm listesi Cinemeta'dan, her bölümün sürümleri Torrentio'dan (en çok 4 eşzamanlı istek).
   */
  async season (imdbId, season) {
    const meta = await this.meta.fetch('series', imdbId, { save: false })
    if (!meta) throw new Error('Dizi bilgisi alınamadı (Cinemeta)')
    const eps = (meta.videos || []).filter(v => +v.season === +season && +v.episode > 0)
      .sort((a, b) => a.episode - b.episode)
      .filter((v, i, arr) => i === 0 || arr[i - 1].episode !== v.episode)
    if (!eps.length) throw new Error('Bu sezonda bölüm bulunamadı')
    const results = new Array(eps.length)
    let next = 0
    const worker = async () => {
      while (next < eps.length) {
        const i = next++
        const id = `${imdbId}:${season}:${eps[i].episode}`
        try { results[i] = await this.versions('series', id) } catch (e) { results[i] = { error: e.message } }
      }
    }
    await Promise.all([1, 2, 3, 4].map(worker))

    const packs = new Map()
    const episodes = eps.map((v, i) => {
      const r = results[i]
      const list = Array.isArray(r) ? r : []
      for (const x of list) {
        if (x.kind !== 'pack') continue
        let p = packs.get(x.infoHash)
        if (!p) {
          p = {
            infoHash: x.infoHash, name: x.name, quality: x.quality, tags: x.tags, sizeBytes: x.sizeBytes, sizeGB: x.sizeGB,
            seeders: x.seeders, source: x.source, languages: x.languages, languageTags: x.languageTags,
            languageText: x.languageText, trackers: x.trackers,
            multiSeason: /\bS\d{1,2}\s*[-–]\s*S?\d{1,2}\b|complete|komple|tüm sezon/i.test(x.name),
            episodes: []
          }
          packs.set(x.infoHash, p)
        }
        p.seeders = Math.max(p.seeders, x.seeders)
        p.episodes.push({ season: +season, episode: +v.episode, fileIdx: x.fileIdx, fileName: x.fileName })
      }
      return {
        season: +season,
        episode: +v.episode,
        id: `${imdbId}:${season}:${v.episode}`,
        title: v.name || v.title || '',
        released: v.released || null,
        error: Array.isArray(r) ? null : r?.error || 'yanıt yok',
        options: list
      }
    })
    const packList = [...packs.values()].map(p => ({ ...p, episodeCount: p.episodes.length, sizeIsTorrentTotal: true }))
      .sort((a, b) => b.episodeCount - a.episodeCount || b.seeders - a.seeders)
    return {
      imdbId,
      season: +season,
      name: meta.name,
      episodeCount: eps.length,
      packs: packList,
      episodes
    }
  }
}
