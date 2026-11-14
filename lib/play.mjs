// Oynatma ucu: tamamlanmış dosya doğrudan diskten, inmekte olan dosya rqbit akışından
// (Range ve ileri sarma; istenen bölge motorda öne alınır) sunulur.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { log } from './log.mjs'

export const MIME = { '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.srt': 'application/x-subrip' }

export function parseRange (header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start, end
  if (m[1] === '') { start = Math.max(0, size - +m[2]); end = size - 1 } else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1) }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

function head (req, res, size, name) {
  const range = parseRange(req.headers.range, size)
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    return null
  }
  const { start, end } = range || { start: 0, end: size - 1 }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': MIME[path.extname(name || '').toLowerCase()] || 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
  })
  if (req.method === 'HEAD') { res.end(); return null }
  return { start, end, partial: !!range }
}

export async function servePlay (req, res, manager, { infoHash, fileIdx, type, id, create = true }) {
  const p = await manager.playable({ infoHash, fileIdx, type, id, create })
  const { file } = p
  if (p.mode === 'disk') {
    const size = fs.statSync(file.path).size
    const r = head(req, res, size, file.name || file.path)
    if (!r) return
    const s = fs.createReadStream(file.path, { start: r.start, end: r.end })
    s.on('error', () => res.destroy())
    res.on('close', () => s.destroy())
    s.pipe(res)
    return
  }
  const r = head(req, res, file.length, file.name)
  if (!r) return
  const ac = new AbortController()
  // Akış bağlantısı açık kaldıkça bu indirme kısılmaz ve kendi sınırı askıdadır (bağlantının yaşamı boyunca)
  const streamEnd = manager.streamBegin(p.item.infoHash)
  res.on('close', () => { ac.abort(); streamEnd() })
  if (res.destroyed) streamEnd()
  await manager.syncLimits().catch(() => {})
  let up
  try {
    up = await fetch(p.url, { headers: { Range: `bytes=${r.start}-${r.end}` }, signal: ac.signal })
  } catch (e) {
    if (!ac.signal.aborted) log('akış açılamadı:', e.message)
    return res.destroy()
  }
  if (up.status !== 206 && up.status !== 200) {
    log('motor akışı hata verdi:', up.status)
    return res.destroy()
  }
  const body = Readable.fromWeb(up.body)
  body.on('error', () => res.destroy())
  body.pipe(res)
}
