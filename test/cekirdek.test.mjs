// Faz 1 indirme çekirdeği sınamaları (yerel döngü, internetsiz).
// Çalıştırma: npm test   (ya da: node --test --test-concurrency=1 test/)
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  startSeeder, startService, serviceConfig, cleanService, startRqbit, silentPeer, engineStats,
  readRange, waitFor, sleep, rq, killAll, MiB, TEST_DIR, PORTS
} from './harness.mjs'
import { FILM, PACK, sourcePath, readSource } from './fixture.mjs'

let seed, fx
before(async () => { seed = await startSeeder(); fx = seed.fx })
after(() => { killAll() })

const IMDB = 'tt0000001'
/** Tohumlayıcının bu torrent için şimdiye dek gönderdiği bayt (yeniden indirme ölçümü). */
const seedUploaded = async ih => (await rq(seed.base, 'GET', `/torrents/${ih}/stats/v1`)).uploaded_bytes

describe('A: oynatma, duraklat/sürdür, tamamlanınca duraklatma, silme', () => {
  const sc = serviceConfig(1)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop() })

  test('oynatma ucu: inmemiş bölgeye ileri sarma (%70) kaynakla bayt bayt aynı', async () => {
    const ih = fx.film.infoHash
    const url = `${svc.base}/play/movie/${IMDB}/${ih}/0`
    // Oynatma ucu bilinmeyen hash için indirme başlatmaz (K1): öğe önce kütüphaneye eklenir.
    await svc.api('POST', '/api/items', { infoHash: ih, files: [0], type: 'movie', id: IMDB })
    const start = Math.floor(FILM.size * 0.7) + 12345
    const t0 = Date.now()
    const r = await readRange(url, start, start + MiB - 1)
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), `bytes ${start}-${start + MiB - 1}/${FILM.size}`)
    assert.ok(r.buf.equals(readSource(sourcePath('film'), start, MiB)), 'bayt farkı (ileri sarma)')
    const item = await svc.item(ih)
    assert.equal(item.state, 'downloading')
    assert.ok(item.doneBytes < FILM.size * 0.9, 'ileri sarma sırasında dosyanın çoğu inmemiş olmalı')
    console.log(`  ileri sarma: ${Date.now() - t0} ms, o an inen ${(item.doneBytes / MiB).toFixed(1)} MiB`)
    // baştan, dosya sonu, HEAD, aralık dışı
    const a = await readRange(url, 0, 65535)
    assert.equal(a.status, 206)
    assert.ok(a.buf.equals(readSource(sourcePath('film'), 0, 65536)))
    const z = await readRange(url, FILM.size - 1000, FILM.size - 1)
    assert.ok(z.buf.equals(readSource(sourcePath('film'), FILM.size - 1000, 1000)))
    const h = await fetch(url, { method: 'HEAD' })
    assert.equal(h.status, 200)
    assert.equal(h.headers.get('content-length'), String(FILM.size))
    assert.equal(h.headers.get('accept-ranges'), 'bytes')
    const bad = await fetch(url, { headers: { Range: `bytes=${FILM.size + 5}-` } })
    assert.equal(bad.status, 416)
    await bad.arrayBuffer()
  })

  test('canlı durum, duraklat ve sürdür', async () => {
    const ih = fx.film.infoHash
    const live = await waitFor(async () => {
      const i = await svc.item(ih)
      return i.state === 'downloading' && i.downloadSpeed > 0 && i.peers >= 1 && i.eta != null && i.percent > 0 && i
    }, { what: 'canlı hız/peer/kalan süre' })
    console.log(`  canlı: %${live.percent} hız ${(live.downloadSpeed / MiB).toFixed(2)} MiB/s, kalan ${live.eta} sn, peer ${live.peers}`)
    const st = await svc.api('GET', '/api/status')
    assert.ok(st.usedBytes > 0 && st.diskFreeBytes > 0 && st.downloadSpeed > 0)
    const p = await svc.api('POST', `/api/items/${ih}/pause`)
    assert.equal(p.state, 'paused')
    assert.equal(p.downloadSpeed, 0)
    await sleep(800)
    const e1 = await engineStats(svc, ih)
    assert.equal(e1.state, 'paused')
    await sleep(2500)
    const e2 = await engineStats(svc, ih)
    assert.equal(e2.progress_bytes, e1.progress_bytes, 'duraklatılmışken ilerleme değişmemeli')
    const i2 = await svc.item(ih)
    assert.equal(i2.state, 'paused')
    // ikinci duraklatma hatasız (idempotent)
    await svc.api('POST', `/api/items/${ih}/pause`)
    const r = await svc.api('POST', `/api/items/${ih}/resume`)
    assert.equal(r.state, 'downloading')
    await waitFor(async () => (await engineStats(svc, ih)).progress_bytes > e2.progress_bytes, { what: 'sürdürünce ilerleme' })
  })

  test('tamamlanınca torrent duraklatılır, sonrasında yükleme yok', async () => {
    const ih = fx.film.infoHash
    const done = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 60000, what: 'tamamlandı' })
    assert.equal(done.percent, 100)
    assert.ok(done.completedAt)
    const e = await engineStats(svc, ih)
    assert.equal(e.state, 'paused')
    assert.equal(e.finished, true)
    const file = path.join(sc.downloadDir, FILM.name)
    assert.ok(readSource(file, 0, 4 * MiB).equals(readSource(sourcePath('film'), 0, 4 * MiB)))
    assert.ok(readSource(file, FILM.size - 4 * MiB, 4 * MiB).equals(readSource(sourcePath('film'), FILM.size - 4 * MiB, 4 * MiB)))
    // Yalnızca bu servisi tanıyan bir eş: 6 sn içinde hiçbir bayt alamamalı
    const leech = await startRqbit({ name: 'leech', api: PORTS.leech, port: PORTS.leech + 1, out: path.join(TEST_DIR, 'leech-out') })
    try {
      await rq(leech.base, 'POST', `/torrents?overwrite=true&initial_peers=127.0.0.1:${sc.peerPort}`, fx.film.torrent)
      await sleep(6000)
      const ls = await rq(leech.base, 'GET', `/torrents/${ih}/stats/v1`)
      const e2 = await engineStats(svc, ih)
      console.log(`  sömürücü eş aldı: ${ls.progress_bytes} bayt; servis yüklemesi: ${e2.uploaded_bytes} bayt`)
      assert.equal(ls.progress_bytes, 0)
      assert.equal(e2.uploaded_bytes, e.uploaded_bytes)
    } finally { leech.stop() }
  })

  test('bitmiş dosya diskten sunulur (motor duraklatılmışken)', async () => {
    const url = `${svc.base}/play/movie/${IMDB}/${fx.film.infoHash}/0`
    const ofs = Math.floor(FILM.size / 3)
    const r = await readRange(url, ofs, ofs + 2 * MiB - 1)
    assert.equal(r.status, 206)
    assert.ok(r.buf.equals(readSource(sourcePath('film'), ofs, 2 * MiB)))
    // Stremio uçları: akış listesinde "Offline Hazır", katalog ve meta
    const s = await svc.api('GET', `/stream/movie/${IMDB}.json`)
    assert.ok(s.streams.some(x => x.name.includes('Offline') && x.url.endsWith(`/${fx.film.infoHash}/0`)))
  })

  test('sil: öğe ve dosyalar kaldırılır', async () => {
    const ih = fx.film.infoHash
    await svc.api('DELETE', `/api/items/${ih}`)
    const items = await svc.api('GET', '/api/items')
    assert.equal(items.items.length, 0)
    assert.equal(await engineStats(svc, ih), null)
    assert.ok(!fs.existsSync(path.join(sc.downloadDir, FILM.name)))
  })
})

describe('B: dosya seçimiyle ekleme, seçim değişikliği, iptal', () => {
  const sc = serviceConfig(2)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop() })

  test('paket: yalnızca seçili bölümler iner, bölümler eşlenir', async () => {
    const ih = fx.pack.infoHash
    const r = await svc.api('POST', '/api/items', { infoHash: ih, files: [0, 2], type: 'series', id: 'tt0000002:1:1', title: 'Test Show S01' })
    assert.equal(r.existed, false)
    const item = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 60000, what: 'seçili dosyalar tamamlandı' })
    const sel = item.files.filter(f => f.selected).map(f => f.idx)
    assert.deepEqual(sel, [0, 2])
    assert.equal(item.sizeBytes, PACK.files[0].size + PACK.files[2].size)
    const e1 = item.files.find(f => f.idx === 0)
    const e2 = item.files.find(f => f.idx === 2)
    assert.equal(e1.videoId, 'tt0000002:1:1')
    assert.equal(e2.videoId, 'tt0000002:1:2')
    const e3 = item.files.find(f => f.idx === 3)
    assert.equal(e3.selected, false)
    assert.ok(e3.doneBytes < 512 * 1024, 'seçilmeyen dosya inmemeli (en çok parça sınırı)')
    const out = path.join(sc.downloadDir, PACK.name)
    assert.ok(readSource(path.join(out, PACK.files[2].components[0]), 0, MiB).equals(readSource(sourcePath('pack', 2), 0, MiB)))
    // dosya önizleme ucu (eklemeden)
    const pv = await svc.api('GET', `/api/torrents/${ih}/files?season=1`)
    assert.equal(pv.episodeCount, 3)
    assert.deepEqual(pv.episodes.map(e => e.fileIdx), [0, 2, 3])
  })

  test('seçim değişikliği: tamamlanmış pakete bölüm eklemek indirmeyi sürdürür', async () => {
    const ih = fx.pack.infoHash
    const r = await svc.api('POST', `/api/items/${ih}/files`, { files: [0, 2, 3] })
    assert.equal(r.state, 'downloading')
    const item = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 60000, what: 'E03 de indi' })
    assert.equal(item.files.find(f => f.idx === 3).complete, true)
    assert.equal(item.files.find(f => f.idx === 3).videoId, 'tt0000002:1:3')
    const s = await svc.api('GET', '/stream/series/tt0000002:1:3.json')
    assert.ok(s.streams.some(x => x.name.includes('Offline')))
    const c = await svc.api('GET', '/catalog/series/offline-series.json')
    assert.ok(Array.isArray(c.metas))
  })

  test('iptal: inmekte olan indirme durur, kısmi dosya silinir', async () => {
    const ih = fx.film.infoHash
    await svc.api('POST', '/api/items', { infoHash: ih, files: [0], type: 'movie', id: IMDB })
    await waitFor(async () => { const i = await svc.item(ih); return i.state === 'downloading' && i.doneBytes > 2 * MiB }, { what: 'film inmeye başladı' })
    await svc.api('POST', `/api/items/${ih}/cancel`)
    await assert.rejects(svc.item(ih), e => e.status === 404)
    assert.equal(await engineStats(svc, ih), null)
    await sleep(500)
    assert.ok(!fs.existsSync(path.join(sc.downloadDir, FILM.name)), 'kısmi dosya silinmeli')
    // tamamlanmış öğe iptal edilemez (409), silinebilir
    await assert.rejects(svc.api('POST', `/api/items/${fx.pack.infoHash}/cancel`), e => e.status === 409)
  })
})

describe('C: servis yeniden başlatma (indirme ortasında), motor çökmesi', () => {
  const sc = serviceConfig(3)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop() })

  test('sert kapanış sonrası durum geri gelir, baştan indirilmez', async () => {
    const ih = fx.film.infoHash
    await svc.api('POST', '/api/items', { infoHash: ih, files: [0], type: 'movie', id: IMDB })
    const before = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'downloading' && i.doneBytes > FILM.size * 0.3 && i }, { timeout: 60000, what: '%30' })
    // Eşzamanlı olarak duraklatılmış bir paket de olsun: yeniden açılışta duraklatılmış kalmalı
    await svc.api('POST', '/api/items', { infoHash: fx.pack.infoHash, files: [3], type: 'series', id: 'tt0000002:1:3' })
    await waitFor(async () => (await svc.item(fx.pack.infoHash)).state === 'downloading', { what: 'paket eklendi' })
    await svc.api('POST', `/api/items/${fx.pack.infoHash}/pause`)
    await svc.kill() // rqbit yetim kalır
    const up0 = await seedUploaded(ih)
    svc = await startService(sc) // önceki rqbit'i kapatıp yenisini başlatmalı
    const item = await svc.item(ih)
    assert.ok(item.doneBytes >= before.doneBytes * 0.9, `ilerleme korunmalı (${item.doneBytes} < ${before.doneBytes})`)
    const done = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 60000, what: 'yeniden açılış sonrası tamamlandı' })
    assert.equal(done.percent, 100)
    // Yeniden açılıştan sonra tohumlayıcının gönderdiği bayt: kalan kısımdan fazla olmamalı (baştan indirme yok)
    const fetchedThisSession = (await seedUploaded(ih)) - up0
    console.log(`  yeniden açılış: önce ${(before.doneBytes / MiB).toFixed(1)} MiB, bu oturumda inen ${(fetchedThisSession / MiB).toFixed(1)} MiB`)
    assert.ok(fetchedThisSession <= FILM.size - before.doneBytes + 4 * MiB, 'baştan indirilmiş')
    const p = await svc.item(fx.pack.infoHash)
    assert.equal(p.state, 'paused')
    const pe = await engineStats(svc, fx.pack.infoHash)
    assert.ok(!pe || pe.state === 'paused', 'duraklatılmış paket motorda çalışmamalı')
    const file = path.join(sc.downloadDir, FILM.name)
    for (const ofs of [0, Math.floor(FILM.size / 2), FILM.size - MiB]) assert.ok(readSource(file, ofs, MiB).equals(readSource(sourcePath('film'), ofs, MiB)))
  })

  test('motordan düşen torrent yeniden eklenir; rqbit çökerse yeniden başlatılır', async () => {
    const ih = fx.pack.infoHash
    await svc.api('POST', `/api/items/${ih}/resume`)
    await waitFor(async () => (await svc.item(ih)).state === 'downloading', { what: 'paket sürdü' })
    // motor kendi başına torrenti "unutursa" (Faz 0: başlatılamayan torrent sessizce düşer)
    await rq(svc.rqbit, 'POST', `/torrents/${ih}/forget`)
    await waitFor(async () => (await engineStats(svc, ih)) !== null, { what: 'yeniden eklendi' })
    // rqbit sürecini öldür: gözetmen yeniden başlatmalı
    const st0 = await svc.api('GET', '/api/status')
    const pid = Number(fs.readFileSync(path.join(sc.dataDir, 'rqbit', 'rqbit.pid'), 'utf8'))
    process.kill(pid)
    await waitFor(async () => { const s = await svc.api('GET', '/api/status'); return s.engine.ready && s.engine.restarts > st0.engine.restarts }, { timeout: 20000, what: 'rqbit yeniden başladı' })
    const done = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 60000, what: 'paket tamamlandı' })
    assert.equal(done.files.find(f => f.idx === 3).complete, true)
  })
})

describe('D: metadata gelmeyen magnet', () => {
  const sc = serviceConfig(4, { OFFLINE_EXTRA_PEERS: `127.0.0.1:${PORTS.silentPeer}`, OFFLINE_METADATA_TIMEOUT: '4' })
  let svc, peer
  before(async () => { cleanService(sc); peer = silentPeer(PORTS.silentPeer); svc = await startService(sc) })
  after(async () => { await svc?.stop(); peer?.close() })

  test('zaman aşımı öğede hata olarak görünür, servis yanıt vermeye devam eder', async () => {
    const ih = 'ab'.repeat(20)
    const t0 = Date.now()
    await svc.api('POST', '/api/items', { magnet: `magnet:?xt=urn:btih:${ih}&dn=Yok`, type: 'movie', id: 'tt0000009' })
    assert.equal((await svc.item(ih)).state, 'resolving')
    const item = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'error' && i }, { timeout: 20000, what: 'hata durumu' })
    const sec = (Date.now() - t0) / 1000
    console.log(`  hata ${sec.toFixed(1)} sn sonra: ${item.error}`)
    assert.match(item.error, /alınamadı/)
    assert.ok(sec < 10)
    assert.equal(await engineStats(svc, ih), null, 'motorda iz kalmamalı')
    const st = await svc.api('GET', '/api/status')
    assert.equal(st.engine.ready, true)
    // sürdür yeniden dener, yine hata; sonra silinebilir
    await svc.api('POST', `/api/items/${ih}/resume`)
    await waitFor(async () => (await svc.item(ih)).state === 'error', { timeout: 20000, what: 'yeniden hata' })
    await svc.api('DELETE', `/api/items/${ih}`)
    // geçersiz istekler hata kodu döner, servis düşmez
    await assert.rejects(svc.api('POST', '/api/items', { infoHash: 'xyz' }), e => e.status === 400)
    await assert.rejects(svc.api('POST', '/api/items/abc/pause'), e => e.status === 404)
    const bad = await fetch(svc.base + '/api/items', { method: 'POST', body: '{bozuk' })
    assert.equal(bad.status, 400)
    assert.equal((await svc.api('GET', '/api/status')).engine.ready, true)
  })
})

describe('E: eski kütüphanenin taşınması', () => {
  const sc = serviceConfig(5)
  let svc
  before(async () => {
    cleanService(sc)
    fs.mkdirSync(sc.dataDir, { recursive: true })
    fs.mkdirSync(sc.downloadDir, { recursive: true })
    // Eski biçim: biri bitmiş (dosyası diskte), biri yarım kalmış (%25)
    const donePath = path.join(sc.downloadDir, 'Eski.Bitmis.mkv')
    fs.writeFileSync(donePath, readSource(sourcePath('pack', 0), 0, 3 * MiB))
    const partial = path.join(sc.downloadDir, FILM.name)
    const fd = fs.openSync(partial, 'w')
    fs.writeSync(fd, readSource(sourcePath('film'), 0, FILM.size / 4), 0, FILM.size / 4, 0)
    fs.ftruncateSync(fd, FILM.size)
    fs.closeSync(fd)
    const v1 = [
      { key: 'c'.repeat(40) + ':x', infoHash: 'c'.repeat(40), fileIdx: null, type: 'movie', id: 'tt0000003', imdbId: 'tt0000003', season: null, episode: null, title: '', fileName: 'Eski.Bitmis.mkv', trackers: [], state: 'done', progress: 1, addedAt: 1, size: 3 * MiB, filePath: donePath, name: 'Eski', doneAt: 2 },
      { key: fx.film.infoHash + ':0', infoHash: fx.film.infoHash, fileIdx: 0, type: 'movie', id: IMDB, imdbId: IMDB, season: null, episode: null, title: 'Test Film 1080p\n👤 5 💾 50 MB ⚙️ Test', fileName: FILM.name, trackers: ['udp://tracker.example:1337/announce'], state: 'downloading', progress: 0.25, addedAt: 3, size: FILM.size, filePath: partial, name: 'Test Film' }
    ]
    fs.writeFileSync(path.join(sc.dataDir, 'library.json'), JSON.stringify(v1, null, 2))
    svc = await startService(sc)
  })
  after(async () => { await svc?.stop() })

  test('eski kayıtlar duraklatılmış/tamamlanmış taşınır, hiçbir şey kendiliğinden inmez', async () => {
    const list = await svc.api('GET', '/api/items')
    assert.equal(list.items.length, 2)
    const old = list.items.find(i => i.infoHash === 'c'.repeat(40))
    const film = list.items.find(i => i.infoHash === fx.film.infoHash)
    assert.equal(old.state, 'completed')
    assert.equal(film.state, 'paused')
    assert.equal(film.percent, 25)
    assert.ok(fs.existsSync(path.join(sc.dataDir, 'library.v1.json')))
    const saved = JSON.parse(fs.readFileSync(path.join(sc.dataDir, 'library.json'), 'utf8'))
    assert.equal(saved.version, 2)
    await sleep(3000)
    const torrents = await rq(svc.rqbit, 'GET', '/torrents')
    assert.equal(torrents.torrents.length, 0, 'motora hiçbir şey eklenmemeli')
    assert.equal((await svc.item(fx.film.infoHash)).state, 'paused')
    // Bitmiş eski kayıt diskten oynar (motora gerek yok)
    const r = await readRange(`${svc.base}/play/movie/tt0000003/${'c'.repeat(40)}/x`, 100, 1123)
    assert.equal(r.status, 206)
    assert.ok(r.buf.equals(readSource(sourcePath('pack', 0), 100, 1024)))
    const m = await svc.api('GET', '/catalog/movie/offline-movies.json')
    assert.ok(m.metas.some(x => x.id === 'tt0000003'))
  })

  test('taşınan yarım kayıt sürdürülünce kaldığı yerden tamamlanır', async () => {
    const ih = fx.film.infoHash
    const up0 = await seedUploaded(ih)
    await svc.api('POST', `/api/items/${ih}/resume`)
    const done = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 60000, what: 'taşınan kayıt tamamlandı' })
    const fetched = (await seedUploaded(ih)) - up0
    console.log(`  taşınan kayıt: bu oturumda inen ${(fetched / MiB).toFixed(1)} MiB / ${(FILM.size / MiB).toFixed(0)} MiB`)
    assert.ok(fetched <= FILM.size * 0.75 + 4 * MiB, 'var olan %25 yeniden indirilmemeli')
    assert.equal(done.files[0].path, path.join(sc.downloadDir, FILM.name))
    const file = path.join(sc.downloadDir, FILM.name)
    for (const ofs of [0, Math.floor(FILM.size / 2), FILM.size - MiB]) assert.ok(readSource(file, ofs, MiB).equals(readSource(sourcePath('film'), ofs, MiB)))
  })
})
