// Sınama yükleri: deterministik sözde-rastgele dosyalar + .torrent (tracker yok, internet yok).
// Varsayılan klasör işletim sisteminin geçici klasörü altındadır; OFFLINE_TEST_DIR ile değiştirilebilir.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTorrent, parseTorrent } from '../lib/bencode.mjs'

export const TEST_DIR = process.env.OFFLINE_TEST_DIR || path.join(os.tmpdir(), 'stremio-offline-sinama')
export const SOURCE = path.join(TEST_DIR, 'kaynak')
const MiB = 1024 * 1024
const PIECE = 256 * 1024

export const FILM = { name: 'Test.Film.2023.1080p.mkv', size: 48 * MiB, seed: 'film' }
export const PACK = {
  name: 'Test.Show.S01.1080p',
  files: [
    { components: ['Test.Show.S01E01.1080p.mkv'], size: 12 * MiB, seed: 'e1' },
    { components: ['Test.Show.S01E01.1080p.srt'], size: 2000, seed: 'srt' },
    { components: ['Test.Show.S01E02.1080p.mkv'], size: 12 * MiB, seed: 'e2' },
    { components: ['Test.Show.S01E03.1080p.mkv'], size: 12 * MiB, seed: 'e3' },
    { components: ['Ekstra', 'Sample.mkv'], size: 1 * MiB, seed: 'sample' }
  ]
}

// aes-128-ctr ile sıfır akışını şifrelemek: hızlı, tohumdan türetilmiş, konumdan okunabilir bayt akışı
export function bytesAt (seed, offset, length) {
  const key = crypto.createHash('sha256').update(seed).digest().subarray(0, 16)
  const block = Math.floor(offset / 16)
  const iv = Buffer.alloc(16)
  iv.writeBigUInt64BE(BigInt(block), 8)
  const c = crypto.createCipheriv('aes-128-ctr', key, iv)
  const skip = offset - block * 16
  return c.update(Buffer.alloc(length + skip)).subarray(skip)
}

function writeFile (file, size, seed) {
  if (fs.existsSync(file) && fs.statSync(file).size === size) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'w')
  for (let pos = 0; pos < size; pos += 4 * MiB) fs.writeSync(fd, bytesAt(seed, pos, Math.min(4 * MiB, size - pos)), 0, Math.min(4 * MiB, size - pos), pos)
  fs.closeSync(fd)
}

export function sourcePath (which, i = 0) {
  return which === 'film' ? path.join(SOURCE, FILM.name) : path.join(SOURCE, PACK.name, ...PACK.files[i].components)
}

export function readSource (file, offset, length) {
  const fd = fs.openSync(file, 'r')
  const b = Buffer.alloc(length)
  fs.readSync(fd, b, 0, length, offset)
  fs.closeSync(fd)
  return b
}

/** Yükleri ve .torrent dosyalarını üretir; { film, pack } -> { torrent (Buffer), infoHash, files } */
export function makeFixtures () {
  writeFile(sourcePath('film'), FILM.size, FILM.seed)
  PACK.files.forEach((f, i) => writeFile(sourcePath('pack', i), f.size, f.seed))
  const film = createTorrent({
    name: FILM.name, pieceLength: PIECE,
    files: [{ components: [FILM.name], length: FILM.size }],
    readAt: (_, o, n) => bytesAt(FILM.seed, o, n)
  })
  const pack = createTorrent({
    name: PACK.name, pieceLength: PIECE,
    files: PACK.files.map(f => ({ components: f.components, length: f.size })),
    readAt: (i, o, n) => bytesAt(PACK.files[i].seed, o, n)
  })
  const tdir = path.join(TEST_DIR, 'torrent')
  fs.mkdirSync(tdir, { recursive: true })
  fs.writeFileSync(path.join(tdir, 'film.torrent'), film)
  fs.writeFileSync(path.join(tdir, 'pack.torrent'), pack)
  return { film: { torrent: film, ...parseTorrent(film) }, pack: { torrent: pack, ...parseTorrent(pack) } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const t = Date.now()
  const f = makeFixtures()
  console.log(TEST_DIR, f.film.infoHash, f.pack.infoHash, Date.now() - t, 'ms')
}
