// Yerel sinama fixture uretici: deterministik sözde-rastgele yükler + .torrent (tracker yok, internet yok).
// Kullanim: node tools/yerel-sinama/fixture.mjs [--kucuk]   (--kucuk: hizli deneme icin boyutlari 1/10'a indirir)
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createTorrent } from '../../lib/bencode.mjs'

export const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DIZIN = path.join(KOK, 'data', 'bench-yerel')
const kucuk = process.argv.includes('--kucuk')
const MB = 1024 * 1024
export const BOYUT = { buyuk: (kucuk ? 150 : 1500) * MB, bolum: (kucuk ? 20 : 200) * MB }
export const ADLAR = {
  buyuk: 'Buyuk.Film.2160p.mkv',
  paket: 'Show.S01',
  bolumler: [1, 2, 3, 4].map(n => `Show.S01E0${n}.mkv`),
  altyazi: 'Show.S01E01.srt',
}

// aes-128-ctr ile sifir akisini sifrelemek = hizli, deterministik, tohumdan turetilmis bayt akisi
function yaz(dosya, boyut, tohum) {
  const key = crypto.createHash('sha256').update(tohum).digest().subarray(0, 16)
  const c = crypto.createCipheriv('aes-128-ctr', key, Buffer.alloc(16))
  const fd = fs.openSync(dosya, 'w')
  const parca = Buffer.alloc(4 * MB)
  for (let yazilan = 0; yazilan < boyut;) {
    const n = Math.min(parca.length, boyut - yazilan)
    fs.writeSync(fd, c.update(parca.subarray(0, n)))
    yazilan += n
  }
  fs.closeSync(fd)
}

// Tracker'siz .torrent (lib/bencode.mjs ile; webtorrent/create-torrent bagimliligi yok)
function torrentYap(girdi, hedef, pieceLength) {
  const tek = fs.statSync(girdi).isFile()
  const dosyalar = tek ? [{ components: [path.basename(girdi)], tam: girdi }]
    : fs.readdirSync(girdi).sort().map(ad => ({ components: [ad], tam: path.join(girdi, ad) }))
  for (const d of dosyalar) d.length = fs.statSync(d.tam).size
  const fds = dosyalar.map(d => fs.openSync(d.tam, 'r'))
  try {
    const buf = createTorrent({ name: path.basename(girdi), pieceLength, files: dosyalar, readAt: (i, ofs, n) => {
      const b = Buffer.alloc(n); fs.readSync(fds[i], b, 0, n, ofs); return b } })
    fs.writeFileSync(hedef, buf)
    return hedef
  } finally { fds.forEach(fd => fs.closeSync(fd)) }
}

export async function uret() {
  const kaynak = path.join(DIZIN, 'kaynak')
  const paket = path.join(kaynak, ADLAR.paket)
  fs.mkdirSync(paket, { recursive: true })
  const buyuk = path.join(kaynak, ADLAR.buyuk)
  if (!fs.existsSync(buyuk) || fs.statSync(buyuk).size !== BOYUT.buyuk) yaz(buyuk, BOYUT.buyuk, 'buyuk')
  ADLAR.bolumler.forEach((ad, i) => {
    const f = path.join(paket, ad)
    if (!fs.existsSync(f) || fs.statSync(f).size !== BOYUT.bolum) yaz(f, BOYUT.bolum, 'bolum' + i)
  })
  fs.writeFileSync(path.join(paket, ADLAR.altyazi), '1\n00:00:01,000 --> 00:00:02,000\nmerhaba\n')
  const tdir = path.join(DIZIN, 'torrent'); fs.mkdirSync(tdir, { recursive: true })
  const a = await torrentYap(buyuk, path.join(tdir, 'buyuk.torrent'), 1 * MB)
  const b = await torrentYap(paket, path.join(tdir, 'paket.torrent'), 1 * MB)
  return { kaynak, buyuk, paket, torrentBuyuk: a, torrentPaket: b }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t0 = Date.now(); const r = await uret()
  console.log(JSON.stringify(r, null, 2), `${((Date.now() - t0) / 1000).toFixed(1)} sn`)
}
