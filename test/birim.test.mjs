// Ağsız, süreçsiz birim sınamaları: çözümleyiciler ve taşıma.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStream, parseSize } from '../lib/torrentio.mjs'
import { parseEpisode, mapPackFiles } from '../lib/episodes.mjs'
import { migrateV1 } from '../lib/library.mjs'
import { parseMagnet } from '../lib/manager.mjs'
import { parseRange } from '../lib/play.mjs'
import { encode, decode, parseTorrent, withTrackers, createTorrent } from '../lib/bencode.mjs'

test('Torrentio akışı: paket, boyut (GiB), seeder, dil, kaynak', () => {
  const s = {
    name: 'Torrentio\n1080p',
    title: 'Show (2008) Season 01 S01 (1080p BluRay x265 HEVC 10bit)\nShow S01E02 Name (1080p x265 10bit).mkv\n👤 29 💾 1.41 GB ⚙️ 1337x\nMulti Audio / 🇬🇧 / 🇹🇷',
    infoHash: 'A584351126AFCF50D32BE068F3C9A62550D41ECC',
    fileIdx: 13,
    behaviorHints: { filename: 'Show S01E02 Name (1080p x265 10bit).mkv' },
    sources: ['tracker:udp://tracker.example:1337/announce', 'dht:a584351126afcf50d32be068f3c9a62550d41ecc']
  }
  const v = parseStream(s, 'series', 'tt1:1:2')
  assert.equal(v.infoHash, 'a584351126afcf50d32be068f3c9a62550d41ecc')
  assert.equal(v.kind, 'pack')
  assert.equal(v.fileIdx, 13)
  assert.equal(v.quality, '1080p')
  assert.equal(v.seeders, 29)
  assert.equal(v.source, '1337x')
  assert.deepEqual(v.languages, ['gb', 'tr'])
  assert.deepEqual(v.languageTags, ['Multi Audio'])
  assert.deepEqual(v.trackers, ['udp://tracker.example:1337/announce'])
  assert.equal(v.sizeBytes, Math.round(1.41 * 2 ** 30))
  assert.ok(v.tags.includes('HEVC'))
  const single = parseStream({ name: 'Torrentio\n720p', title: 'Film 2010 720p BluRay\n👤 23 💾 136.47 MB ⚙️ YTS', infoHash: 'b'.repeat(40) }, 'movie', 'tt2')
  assert.equal(single.kind, 'single')
  assert.equal(single.fileIdx, null)
  assert.equal(single.name, 'Film 2010 720p BluRay')
  assert.deepEqual(single.languages, [])
  const ep = parseStream({ name: 'Torrentio\n4k', title: 'Show S01E02 2160p WEB-DL\n👤 32 💾 5.66 GB ⚙️ ThePirateBay', infoHash: 'c'.repeat(40), fileIdx: 0 }, 'series', 'tt1:1:2')
  assert.equal(ep.kind, 'episode')
  assert.equal(parseStream({ title: 'x' }, 'movie', 'tt1'), null)
  assert.equal(parseSize('💾 2 TB'), 2 * 2 ** 40)
})

test('bölüm çözümleme ve paket eşleme', () => {
  assert.deepEqual(parseEpisode('Show.S01E02.1080p.mkv'), { season: 1, episode: 2 })
  assert.deepEqual(parseEpisode('show s2e10 x.mkv'), { season: 2, episode: 10 })
  assert.deepEqual(parseEpisode('Show 3x07.avi'), { season: 3, episode: 7 })
  assert.deepEqual(parseEpisode('Show.S01E01E02.mkv'), { season: 1, episode: 1 })
  assert.equal(parseEpisode('Movie.1920x1080.mkv'), null)
  assert.equal(parseEpisode('Film.2010.1080p.mkv'), null)
  const files = [
    { idx: 0, name: 'Show.S01E01.mkv', components: ['Show.S01', 'Show.S01E01.mkv'], length: 10 },
    { idx: 1, name: 'Show.S01E01.srt', components: ['Show.S01', 'Show.S01E01.srt'], length: 1 },
    { idx: 2, name: 'Episode 02.mkv', components: ['Season 1', 'Episode 02.mkv'], length: 10 },
    { idx: 3, name: 'sample.mkv', components: ['Sample', 'sample.mkv'], length: 1 },
    { idx: 4, name: '03 - Başlık.mkv', components: ['03 - Başlık.mkv'], length: 10 }
  ]
  const m = mapPackFiles(files, { torrentName: 'Show Season 1' })
  assert.deepEqual(m.get(0), { season: 1, episode: 1 })
  assert.equal(m.has(1), false)
  assert.deepEqual(m.get(2), { season: 1, episode: 2 })
  assert.equal(m.has(3), false)
  assert.deepEqual(m.get(4), { season: 1, episode: 3 })
})

test('sürüm 1 kütüphanesi: bitmiş -> completed, yarım -> paused', () => {
  const items = migrateV1([
    { key: 'a'.repeat(40) + ':x', infoHash: 'a'.repeat(40), fileIdx: null, type: 'movie', id: 'tt1', imdbId: 'tt1', title: '', fileName: 'A.mp4', trackers: [], state: 'done', progress: 1, addedAt: 1, size: 100, filePath: 'X:\\indir\\A\\A.mp4', name: 'A', doneAt: 5 },
    { key: 'b'.repeat(40) + ':0', infoHash: 'B'.repeat(40), fileIdx: 0, type: 'movie', id: 'tt2', imdbId: 'tt2', title: 'B 2160p\n👤 15 💾 45.92 GB ⚙️ Site', fileName: 'B.mkv', trackers: ['udp://t:1/announce'], state: 'downloading', progress: 0.25, addedAt: 2, size: 1000, filePath: 'X:\\indir\\B.mkv', name: 'B' },
    { key: 'c'.repeat(40) + ':1', infoHash: 'c'.repeat(40), fileIdx: 1, type: 'series', id: 'tt3:1:2', imdbId: 'tt3', state: 'downloading', progress: 0, addedAt: 3 },
    { key: 'c'.repeat(40) + ':2', infoHash: 'c'.repeat(40), fileIdx: 2, type: 'series', id: 'tt3:1:3', imdbId: 'tt3', state: 'done', progress: 1, size: 50, addedAt: 4 },
    { bozuk: true }
  ])
  assert.equal(items.length, 3)
  const [a, b, c] = items
  assert.equal(a.state, 'completed')
  assert.equal(a.completedAt, 5)
  assert.equal(a.files[0].idx, null)
  assert.equal(a.files[0].progressBytes, 100)
  assert.equal(b.infoHash, 'b'.repeat(40))
  assert.equal(b.state, 'paused')
  assert.equal(b.inEngine, false)
  assert.equal(b.files[0].progressBytes, 250)
  assert.equal(b.title, 'B 2160p')
  assert.equal(c.files.length, 2)
  assert.equal(c.state, 'paused')
  assert.equal(c.files[0].videoId, 'tt3:1:2')
  assert.equal(c.files[1].season, 1)
})

test('magnet, Range, bencode', () => {
  const m = parseMagnet('magnet:?xt=urn:btih:08ADA5A7A6183AAE1E09D831DF6748D566095A10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969')
  assert.equal(m.infoHash, '08ada5a7a6183aae1e09d831df6748d566095a10')
  assert.deepEqual(m.trackers, ['udp://explodie.org:6969'])
  assert.equal(parseMagnet('magnet:?xt=urn:btih:BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ').infoHash, '08ada5a7a6183aae1e09d831df6748d566095a10')
  assert.equal(parseMagnet('http://x'), null)
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 })
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid')
  assert.equal(parseRange(undefined, 1000), null)
  const b = encode({ a: 1, b: 'x', c: [Buffer.from('yz'), 2] })
  assert.equal(b.toString(), 'd1:ai1e1:b1:x1:cl2:yzi2eee')
  assert.equal(decode(b).value.a, 1)
  const t = createTorrent({ name: 'f.mkv', pieceLength: 16384, files: [{ components: ['f.mkv'], length: 40000 }], readAt: (_, o, n) => Buffer.alloc(n, 7) })
  const p = parseTorrent(t)
  assert.equal(p.files.length, 1)
  assert.equal(p.files[0].length, 40000)
  const t2 = withTrackers(t, ['udp://a:1/announce'])
  assert.equal(parseTorrent(t2).infoHash, p.infoHash)
  assert.deepEqual(parseTorrent(t2).trackers, ['udp://a:1/announce'])
})

test('K3: Library.delete büyük harfli anahtarla da kaydı siler', async () => {
  const { Library } = await import('../lib/library.mjs')
  const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'))
  try {
    const lib = new Library(path.join(dir, 'library.json'))
    lib.set({ infoHash: 'a'.repeat(40), state: 'paused' })
    assert.ok(lib.get('A'.repeat(40)))
    lib.delete('A'.repeat(40))
    assert.equal(lib.all().length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('K2: tek sezonluk COMPLETE paketi çok sezonlu sayılmaz', async () => {
  const { MULTI_SEASON } = await import('../lib/torrentio.mjs')
  assert.equal(MULTI_SEASON.test('Breaking.Bad.SEASON.01.S01.COMPLETE.1080p.BluRay'), false)
  assert.equal(MULTI_SEASON.test('Show S01-S05 COMPLETE'), true)
})

test('K4: getJson geçici hatada (bağlantı kesilmesi, 5xx) bir kez yeniden dener; 404 denemez', async () => {
  const http = await import('node:http')
  const { getJson } = await import('../lib/meta.mjs')
  let n = 0
  const srv = http.createServer((req, res) => {
    n++
    if (req.url === '/reset' && n === 1) return req.socket.destroy()
    if (req.url === '/5xx' && n === 1) { res.writeHead(503); return res.end('x') }
    if (req.url === '/404') { res.writeHead(404); return res.end('x') }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":1}')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    for (const p of ['/reset', '/5xx']) { n = 0; assert.deepEqual(await getJson(base + p), { ok: 1 }, p); assert.equal(n, 2, p) }
    n = 0
    await assert.rejects(getJson(base + '/404'))
    assert.equal(n, 1)
  } finally { srv.close() }
})

test('K7: meta JSON var ama görsel eksikse yalnızca eksik görsel yeniden indirilir; kaldırma sırasında yeniden eklenen içerik silinmez', async () => {
  const http = await import('node:http'); const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path')
  const { MetaStore } = await import('../lib/meta.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-'))
  const cfg = { metaDir: path.join(dir, 'meta'), imgDir: path.join(dir, 'img') }
  fs.mkdirSync(cfg.metaDir); fs.mkdirSync(cfg.imgDir)
  let hits = 0
  const srv = http.createServer((req, res) => { hits++; if (hits === 1) { res.writeHead(404); return res.end() } res.writeHead(200); res.end('IMG') })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const poster = `http://127.0.0.1:${srv.address().port}/p.jpg`
  try {
    const store = new MetaStore(cfg)
    fs.writeFileSync(store.file('tt1'), JSON.stringify({ id: 'tt1', poster }))
    await store.fetch('movie', 'tt1')
    assert.ok(!fs.existsSync(path.join(cfg.imgDir, 'tt1-poster')), 'ilk deneme 404')
    store.imgTried.clear() // 10 dk bekleme geçti say
    await store.fetch('movie', 'tt1')
    assert.equal(fs.readFileSync(path.join(cfg.imgDir, 'tt1-poster'), 'utf8'), 'IMG')
    // kaldırma, içerik yeniden eklenmişse (inUse) hiçbir şey silmez
    await store.remove('tt1', () => true)
    assert.ok(fs.existsSync(store.file('tt1')) && fs.existsSync(path.join(cfg.imgDir, 'tt1-poster')))
    await store.remove('tt1', () => false)
    assert.ok(!fs.existsSync(store.file('tt1')) && !fs.existsSync(path.join(cfg.imgDir, 'tt1-poster')))
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
