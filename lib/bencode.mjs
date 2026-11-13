// Küçük bencode kodlayıcı/çözücü ve .torrent yardımcıları (bağımlılıksız).
import crypto from 'node:crypto'

export function decode (buf) {
  let i = 0
  const infoRange = {}
  function next (depth, keyPath) {
    const c = buf[i]
    if (c === 0x69) { // i
      const e = buf.indexOf(0x65, i)
      const n = Number(buf.toString('latin1', i + 1, e))
      i = e + 1
      return n
    }
    if (c === 0x6c) { // l
      i++
      const out = []
      while (buf[i] !== 0x65) out.push(next(depth + 1))
      i++
      return out
    }
    if (c === 0x64) { // d
      i++
      const out = {}
      while (buf[i] !== 0x65) {
        const k = next(depth + 1).toString('utf8')
        const start = i
        out[k] = next(depth + 1, k)
        if (depth === 0 && k === 'info') { infoRange.start = start; infoRange.end = i }
      }
      i++
      return out
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, i)
      const len = Number(buf.toString('latin1', i, colon))
      const s = buf.subarray(colon + 1, colon + 1 + len)
      i = colon + 1 + len
      return Buffer.from(s)
    }
    throw new Error('bencode: geçersiz veri, konum ' + i)
  }
  const value = next(0)
  return { value, infoRange }
}

export function encode (v) {
  const parts = []
  const w = x => {
    if (Buffer.isBuffer(x)) { parts.push(Buffer.from(x.length + ':'), x); return }
    if (typeof x === 'string') { const b = Buffer.from(x, 'utf8'); parts.push(Buffer.from(b.length + ':'), b); return }
    if (typeof x === 'number') { parts.push(Buffer.from('i' + Math.trunc(x) + 'e')); return }
    if (Array.isArray(x)) { parts.push(Buffer.from('l')); x.forEach(w); parts.push(Buffer.from('e')); return }
    if (x && typeof x === 'object') {
      parts.push(Buffer.from('d'))
      for (const k of Object.keys(x).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
        if (x[k] === undefined) continue
        w(k); w(x[k])
      }
      parts.push(Buffer.from('e'))
      return
    }
    throw new Error('bencode: desteklenmeyen tür')
  }
  w(v)
  return Buffer.concat(parts)
}

const str = b => Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? '')

/** .torrent baytlarını çözer: infoHash, ad, dosyalar (torrent içindeki sırayla), tracker'lar. */
export function parseTorrent (buf) {
  const { value, infoRange } = decode(buf)
  const info = value.info
  if (!info) throw new Error('torrent: info sözlüğü yok')
  const infoHash = crypto.createHash('sha1').update(buf.subarray(infoRange.start, infoRange.end)).digest('hex')
  const name = str(info['name.utf-8'] || info.name)
  let files
  if (Array.isArray(info.files)) {
    files = info.files.map((f, idx) => {
      const components = (f['path.utf-8'] || f.path).map(str)
      return { idx, name: components[components.length - 1], components, length: f.length }
    })
  } else {
    files = [{ idx: 0, name, components: [name], length: info.length }]
  }
  const trackers = []
  if (value.announce) trackers.push(str(value.announce))
  for (const tier of value['announce-list'] || []) for (const t of tier) trackers.push(str(t))
  return { infoHash, name, files, trackers: [...new Set(trackers)].filter(Boolean), pieceLength: info['piece length'] }
}

/** Info sözlüğüne dokunmadan (infoHash değişmez) tracker listesini .torrent'e ekler. */
export function withTrackers (buf, trackers) {
  if (!trackers?.length) return buf
  const { value } = decode(buf)
  const have = new Set()
  if (value.announce) have.add(str(value.announce))
  const list = (value['announce-list'] || []).map(t => t.map(str))
  for (const t of list.flat()) have.add(t)
  for (const t of trackers) if (!have.has(t)) { list.push([t]); have.add(t) }
  if (!value.announce && list.length) value.announce = list[0][0]
  value['announce-list'] = list
  return encode(value)
}

/** Sınama düzeneği için: dosya listesinden .torrent üretir (parçalar SHA-1). */
export function createTorrent ({ name, files, pieceLength, readAt }) {
  // files: [{ components:[...], length }]; readAt(fileIndex, offset, length) -> Buffer
  const total = files.reduce((a, f) => a + f.length, 0)
  const pieces = []
  let fi = 0; let fo = 0
  for (let pos = 0; pos < total; pos += pieceLength) {
    const n = Math.min(pieceLength, total - pos)
    const chunks = []
    let need = n
    while (need > 0) {
      const f = files[fi]
      const take = Math.min(need, f.length - fo)
      if (take > 0) chunks.push(readAt(fi, fo, take))
      fo += take; need -= take
      if (fo >= f.length) { fi++; fo = 0 }
    }
    pieces.push(crypto.createHash('sha1').update(Buffer.concat(chunks)).digest())
  }
  const info = { name, 'piece length': pieceLength, pieces: Buffer.concat(pieces) }
  if (files.length === 1 && files[0].components.length === 1 && files[0].components[0] === name) info.length = files[0].length
  else info.files = files.map(f => ({ length: f.length, path: f.components }))
  return encode({ info, 'created by': 'stremio-offline test' })
}
