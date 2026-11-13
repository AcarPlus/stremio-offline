// Kalıcı kütüphane: data/library.json. Biçim: { version: 2, items: [...] }.
// Eski (sürüm 1, webtorrent dönemi) dizi biçimi açılışta yeni yapıya taşınır; bitmemiş
// kayıtlar "paused" olur ve motora hiç eklenmez (kendiliğinden inmeye başlamaz).
// Eski dosya taşıma öncesi library.v1.json olarak saklanır.
import fs from 'node:fs'
import path from 'node:path'
import { log } from './log.mjs'

export const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|webm|ts|wmv|mpg|mpeg|flv)$/i

/** "tt123:1:2" -> { imdbId, season, episode } */
export function parseStremioId (id) {
  const [imdbId, season, episode] = String(id || '').split(':')
  return { imdbId, season: season ? +season : null, episode: episode ? +episode : null }
}

/** Taşıma: sürüm 1 kayıtlarını (anahtar = infoHash:fileIdx) infoHash başına bir öğede toplar. */
export function migrateV1 (entries) {
  const byHash = new Map()
  for (const e of entries) {
    if (!e || !/^[a-f0-9]{40}$/i.test(e.infoHash || '')) continue
    const ih = e.infoHash.toLowerCase()
    const { imdbId, season, episode } = parseStremioId(e.id)
    let item = byHash.get(ih)
    if (!item) {
      item = {
        infoHash: ih,
        name: '',
        title: (e.title || '').split('\n')[0] || e.fileName || '',
        type: e.type,
        imdbId: e.imdbId || imdbId,
        displayName: e.name || '',
        source: { title: e.title || '' },
        trackers: Array.isArray(e.trackers) ? e.trackers : [],
        state: 'paused',
        error: null,
        inEngine: false,
        addedAt: e.addedAt || Date.now(),
        completedAt: null,
        outputFolder: null,
        files: [],
        migratedFrom: 1
      }
      byHash.set(ih, item)
    }
    const done = e.state === 'done'
    const length = e.size || 0
    item.files.push({
      idx: Number.isInteger(e.fileIdx) ? e.fileIdx : null,
      name: e.fileName || (e.filePath ? path.basename(e.filePath) : ''),
      path: e.filePath || null,
      length,
      selected: true,
      progressBytes: done ? length : Math.round((e.progress || 0) * length),
      videoId: e.id,
      season,
      episode
    })
    if (e.trackers?.length) item.trackers = [...new Set([...item.trackers, ...e.trackers])]
    if (done && e.doneAt) item.completedAt = Math.max(item.completedAt || 0, e.doneAt)
  }
  for (const item of byHash.values()) {
    const allDone = item.files.every(f => f.length && f.progressBytes >= f.length)
    item.state = allDone ? 'completed' : 'paused'
    if (!allDone) item.completedAt = null
  }
  return [...byHash.values()]
}

export class Library {
  constructor (file) {
    this.file = file
    this.items = new Map() // infoHash -> item
    this.timer = null
  }

  load () {
    let raw
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch (e) {
      if (fs.existsSync(this.file)) {
        const bad = this.file + '.bozuk-' + Date.now()
        try { fs.copyFileSync(this.file, bad) } catch {}
        log('kütüphane okunamadı (' + e.message + '); kopyası:', bad)
      }
      raw = { version: 2, items: [] }
    }
    let items
    if (Array.isArray(raw)) {
      const backup = path.join(path.dirname(this.file), 'library.v1.json')
      if (!fs.existsSync(backup)) fs.copyFileSync(this.file, backup)
      items = migrateV1(raw)
      log(`eski kütüphane taşındı: ${raw.length} kayıt -> ${items.length} öğe (yedek: library.v1.json)`)
      this.items = new Map(items.map(i => [i.infoHash, i]))
      this.saveNow()
    } else {
      items = raw.items || []
      this.items = new Map(items.map(i => [i.infoHash, i]))
    }
    return this
  }

  get (ih) { return this.items.get(String(ih || '').toLowerCase()) }
  all () { return [...this.items.values()] }
  set (item) { this.items.set(item.infoHash, item); this.saveNow() }
  delete (ih) { this.items.delete(String(ih || '').toLowerCase()); this.saveNow() }

  /** Gecikmeli kayıt: sık çağrılsa da en geç ~1 sn içinde yazar (zamanlayıcı sıfırlanmaz). */
  save () {
    if (this.timer) return
    this.timer = setTimeout(() => this.saveNow(), 1000)
  }

  saveNow () {
    clearTimeout(this.timer)
    this.timer = null
    const out = { version: 2, items: this.all().map(({ live, ...rest }) => rest) }
    const tmp = this.file + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (e) { log('kütüphane yazılamadı:', e.message) }
  }
}
