// Klip: indirmeden önce 60 sn'lik örnek (lib/klip.mjs). Saf kısımlar + yerel döngü (internetsiz):
// ffmpeg ile sentetik ~3 dk'lık MKV (H.264/AAC + srt) ve MP4 (moov sonda) üretilir, yerel torrent yapılır,
// tohumlayıcıdan geçici motorla akış üzerinden %30 noktasından -c copy kesilir. ffmpeg yoksa ağır sınamalar atlanır.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createTorrent, parseTorrent } from '../lib/bencode.mjs'
import { findFfmpeg, pickStreams, clipWindow, cutArgs, NO_PEERS, gorselAnlari, hdrMi, kareArgs } from '../lib/klip.mjs'
import { startSeeder, startService, serviceConfig, cleanService, waitFor, rq, killAll, readRange, sleep, TEST_DIR } from './harness.mjs'

const ff = await findFfmpeg()
const NOFF = ff.available ? false : 'ffmpeg/ffprobe bulunamadı (Stremio 5 kurulu değil): klip sınamaları atlandı'

// ---------------------------------------------------------------- saf

test('klip: akış seçimi (kapak resmi video sayılmaz, uygun altyazılar)', () => {
  const p = pickStreams({
    format: { duration: '5400.5' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { index: 1, codec_type: 'video', codec_name: 'hevc', disposition: { attached_pic: 0 } },
      { index: 2, codec_type: 'audio', codec_name: 'eac3' },
      { index: 3, codec_type: 'audio', codec_name: 'aac' },
      { index: 4, codec_type: 'subtitle', codec_name: 'subrip' },
      { index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
      { index: 6, codec_type: 'subtitle', codec_name: 'eia_608' },
      { index: 7, codec_type: 'subtitle', codec_name: 'mov_text' }
    ]
  })
  assert.equal(p.video.index, 1)
  assert.equal(p.audio.index, 2)
  assert.deepEqual(p.subs.map(s => s.index), [4, 5, 7])
  assert.equal(p.duration, 5400.5)
  assert.equal(pickStreams({ streams: [] }).video, null)
  assert.equal(pickStreams({ format: { duration: 'N/A' }, streams: [] }).duration, null)
})

test('klip: kesim penceresi %30, en çok 60 sn', () => {
  assert.deepEqual(clipWindow(7200), { start: 2160, length: 60 })
  assert.deepEqual(clipWindow(180), { start: 54, length: 60 })
  assert.deepEqual(clipWindow(50), { start: 15, length: 35 })
  assert.deepEqual(clipWindow(null), { start: 0, length: 60 })
})

test('klip: ffmpeg argümanları (girdi öncesi -ss, -c copy, -map, mov_text -> srt)', () => {
  const picks = { video: { index: 1 }, audio: { index: 2 }, subs: [{ index: 4, codec_name: 'subrip' }, { index: 7, codec_name: 'mov_text' }] }
  const a = cutArgs({ input: 'http://x/s', out: 'o.mkv', start: 54, length: 60, picks, http: true })
  const s = a.join(' ')
  assert.ok(s.indexOf('-ss 54') < s.indexOf('-i http://x/s'), '-ss girdiden önce')
  assert.match(s, /-t 60 -map 0:1 -map 0:2 -map 0:4 -map 0:7 -map 0:t\? -c copy -c:s:1 srt/)
  assert.match(s, /-rw_timeout 60000000/)
  assert.equal(a[a.length - 1], 'o.mkv')
  assert.ok(!/libx264|-crf|-b:v/.test(s), 'yeniden sıkıştırma yok')
  const b = cutArgs({ input: 'f.mkv', out: 'o.mkv', start: 0, length: 60, picks: { video: { index: 0 }, audio: null, subs: [{ index: 3, codec_name: 'ass' }] }, withSubs: false }).join(' ')
  assert.ok(!/0:3|0:t|rw_timeout/.test(b))
})

test('klip: inject yalnız servisin klip dosya adresini oynatır', () => {
  const API = 'http://127.0.0.1:11480'
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'inject.js'), 'utf8').replaceAll('__API__', API)
  const ctx = { URLSearchParams, TextEncoder, Response, Blob, CompressionStream, DecompressionStream, btoa, atob }
  ctx.globalThis = ctx
  vm.runInNewContext(src, ctx)
  const saf = ctx.__offlineIndirSaf
  const msg = playUrl => ({ source: 'offline-indir', type: 'oynat', item: { playUrl } })
  assert.ok(saf.isHostMessage(msg(API + '/api/klip/0123456789abcdef/dosya'), API, API))
  assert.ok(!saf.isHostMessage(msg(API + '/api/klip/0123456789abcdef'), API, API))
  assert.ok(!saf.isHostMessage(msg(API + '/api/items/x'), API, API))
  assert.ok(!saf.isHostMessage(msg('http://127.0.0.1:114800/api/klip/0123456789abcdef/dosya'), API, API))
  assert.ok(!saf.isHostMessage(msg('https://kotu.example/api/klip/0123456789abcdef/dosya'), API, API))
  // Klip kütüphane kimliği taşımaz: oynatıcı adresi yalnız akıştır (izleme geçmişine film olarak yazılmaz)
  assert.equal(saf.playerHash('abc', API, { videoId: null, imdbId: null }), '#/player/abc')
})

// ---------------------------------------------------------------- yerel döngü

const SRC = path.join(TEST_DIR, 'klip-kaynak')
const FILES = ['Klip.Sinama.2020.1080p.x264.mkv', 'Klip.Sinama.2020.1080p.x264.mp4']
const probe = f => JSON.parse(execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', f], { encoding: 'utf8', windowsHide: true }))

function makeVideos () {
  fs.mkdirSync(SRC, { recursive: true })
  const srt = path.join(SRC, 'alt.srt')
  let s = ''
  for (let i = 0; i < 18; i++) {
    const t = n => `00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')},000`
    s += `${i + 1}\n${t(i * 10)} --> ${t(i * 10 + 5)}\nAltyazı ${i + 1}\n\n`
  }
  fs.writeFileSync(srt, s)
  const base = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=180', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=180']
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-b:v', '600k', '-c:a', 'aac', '-b:a', '64k']
  const mkv = path.join(SRC, FILES[0]); const mp4 = path.join(SRC, FILES[1])
  if (!fs.existsSync(mkv)) execFileSync(ff.ffmpeg, [...base, '-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s', ...enc, '-c:s', 'srt', mkv], { windowsHide: true })
  // MP4: moov sonda (faststart yok) — oynatıcı/ffmpeg dosyanın sonunu önce ister
  if (!fs.existsSync(mp4)) execFileSync(ff.ffmpeg, [...base, '-map', '0:v', '-map', '1:a', ...enc, mp4], { windowsHide: true })
  const files = FILES.map(n => ({ components: [n], length: fs.statSync(path.join(SRC, n)).size }))
  const fds = FILES.map(n => fs.openSync(path.join(SRC, n), 'r'))
  const torrent = createTorrent({ name: 'Klip.Sinama.2020', pieceLength: 256 * 1024, files, readAt: (i, o, n) => { const b = Buffer.alloc(n); fs.readSync(fds[i], b, 0, n, o); return b } })
  fds.forEach(fs.closeSync)
  return { torrent, ...parseTorrent(torrent) }
}

let seed, vid
before(async () => {
  if (NOFF) return
  seed = await startSeeder()
  vid = makeVideos()
  await rq(seed.base, 'POST', `/torrents?overwrite=true&output_folder=${encodeURIComponent(SRC)}`, vid.torrent)
  await waitFor(async () => (await rq(seed.base, 'GET', `/torrents/${vid.infoHash}/stats/v1`)).finished, { what: 'tohumlayıcı klip videoları' })
})
after(() => { killAll() })

const waitJob = (svc, id, done = s => ['ready', 'error', 'canceled'].includes(s)) =>
  waitFor(async () => { const j = await svc.api('GET', '/api/klip/' + id); return done(j.state) && j }, { timeout: 120000, interval: 300, what: 'klip işi ' + id })

describe('klip: geçici motorla akıştan 60 sn kesme', { skip: NOFF }, () => {
  const sc = serviceConfig(44, { OFFLINE_FFMPEG: ff.ffmpeg, OFFLINE_METADATA_TIMEOUT: '8' })
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop() })

  test('yetenek ucu ffmpeg\'i bildirir', async () => {
    const c = await svc.api('GET', '/api/klip')
    assert.equal(c.available, true)
    assert.equal(c.ffmpegFrom, 'OFFLINE_FFMPEG')
    assert.equal(c.job, null)
  })

  let mkvJob
  test('MKV (H.264/AAC + altyazı): ~60 sn, oynatılabilir, kütüphaneye eklenmez, motor ve parçalar temizlenir', async () => {
    const r = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 0, type: 'movie', id: 'tt0000044', title: 'Klip Sınama' })
    assert.equal(r.existed, false)
    // Aynı anda tek iş: başka kaynak 409, replace olmadan
    const busy = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 1 }).catch(e => e)
    assert.equal(busy.status, 409)
    assert.equal(busy.body.job.id, r.job.id)
    // Aynı kaynak: aynı iş döner
    assert.equal((await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 0 })).job.id, r.job.id)
    const j = await waitJob(svc, r.job.id)
    assert.equal(j.state, 'ready', j.error)
    assert.equal(j.source, 'torrent')
    assert.ok(Math.abs(j.durationSec - 180) < 1, 'süre ' + j.durationSec)
    assert.equal(j.startSec, 54)
    assert.ok(j.downloadedBytes > 0 && j.downloadedBytes <= vid.files[0].length + 256 * 1024, 'indirilen: ' + j.downloadedBytes) // yerel eş çok hızlı: dosyanın tamamı (+ sınır parçası) inebilir
    const file = path.join(sc.dataDir, 'klipler', j.id + '.mkv')
    const p = probe(file)
    assert.ok(Math.abs(+p.format.duration - 60) <= 5, 'klip süresi ' + p.format.duration)
    assert.deepEqual(p.streams.map(s => s.codec_type + ':' + s.codec_name), ['video:h264', 'audio:aac', 'subtitle:subrip'])
    execFileSync(ff.ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { windowsHide: true }) // çözülebilir
    // Kütüphane boş, klip motoru kapandı, geçici parçalar silindi
    assert.equal((await svc.api('GET', '/api/items')).items.length, 0)
    await waitFor(async () => !(await svc.api('GET', '/api/engines')).engines.some(e => String(e.infoHash).startsWith('klip:')), { what: 'klip motoru kapandı' })
    await waitFor(() => !fs.existsSync(path.join(sc.dataDir, 'klipler', 'gecici', j.id)), { what: 'geçici parçalar silindi' })
    // Dosya sunumu (Range)
    const rg = await readRange(svc.base + '/api/klip/' + j.id + '/dosya', 0, 99)
    assert.equal(rg.status, 206)
    assert.equal(rg.buf.length, 100)
    assert.equal(rg.headers.get('content-type'), 'video/x-matroska')
    assert.equal(rg.buf.readUInt32BE(0), 0x1a45dfa3, 'EBML başlığı')
    assert.equal(j.fileUrl, svc.base + '/api/klip/' + j.id + '/dosya')
    // Hazır klip yeniden istenince yeniden kesilmez
    const again = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 0 })
    assert.equal(again.existed, true)
    assert.equal(again.job.id, j.id)
    mkvJob = j
  })

  test('MP4 (moov sonda): akıştan kesilir; yeni iş eskisini replace ile iptal eder', async () => {
    const first = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 1 })
    const r = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 1, replace: true }) // aynı kaynak: aynı iş
    assert.equal(r.job.id, first.job.id)
    const j = await waitJob(svc, r.job.id)
    assert.equal(j.state, 'ready', j.error)
    const p = probe(path.join(sc.dataDir, 'klipler', j.id + '.mkv'))
    assert.ok(Math.abs(+p.format.duration - 60) <= 5, 'klip süresi ' + p.format.duration)
    assert.deepEqual(p.streams.map(s => s.codec_type), ['video', 'audio'])
    const list = await svc.api('GET', '/api/klip')
    assert.deepEqual(list.klips.map(k => k.id).sort(), [mkvJob.id, j.id].sort())
    // Sil
    assert.deepEqual(await svc.api('DELETE', '/api/klip/' + j.id), { ok: true })
    assert.equal((await svc.api('GET', '/api/klip/' + j.id).catch(e => e)).status, 404)
  })

  test('iptal: çalışan iş durur, motoru kapanır, yarım dosya kalmaz', async () => {
    const a = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 1 })
    assert.equal(a.existed, false)
    const b = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 99, replace: true }) // eskisini iptal eder
    assert.equal((await svc.api('GET', '/api/klip/' + a.job.id)).state, 'canceled')
    await svc.api('DELETE', '/api/klip/' + b.job.id)
    const jb = await waitJob(svc, b.job.id)
    assert.ok(['canceled', 'error'].includes(jb.state), jb.state)
    await waitFor(async () => !(await svc.api('GET', '/api/engines')).engines.some(e => String(e.infoHash).startsWith('klip:')), { what: 'klip motoru kapandı' })
    const left = fs.readdirSync(path.join(sc.dataDir, 'klipler')).filter(n => n.endsWith('.part'))
    assert.deepEqual(left, [])
  })

  test('eşi olmayan kaynak: anlaşılır hata', async () => {
    const r = await svc.api('POST', '/api/klip', { infoHash: 'ab'.repeat(20), fileIdx: 0 })
    const j = await waitJob(svc, r.job.id)
    assert.equal(j.state, 'error')
    assert.ok(j.error.startsWith(NO_PEERS), j.error)
    await waitFor(async () => !(await svc.api('GET', '/api/engines')).engines.some(e => String(e.infoHash).startsWith('klip:')), { what: 'klip motoru kapandı' })
  })

  test('aynı içerik indirilip tamamlanınca klip silinir', async () => {
    assert.ok(fs.existsSync(path.join(sc.dataDir, 'klipler', mkvJob.id + '.mkv')))
    await svc.api('POST', '/api/items', { infoHash: vid.infoHash, files: [0], type: 'movie', id: 'tt0000044' })
    await waitFor(async () => (await svc.item(vid.infoHash)).state === 'completed', { timeout: 60000, what: 'indirme tamam' })
    const c = await svc.api('GET', '/api/klip') // yetenek ucu da denetler (ayrıca dakikada bir)
    assert.ok(!c.klips.some(k => k.id === mkvJob.id))
    assert.ok(!fs.existsSync(path.join(sc.dataDir, 'klipler', mkvJob.id + '.mkv')))
    // İnmiş dosyadan klip motor açmadan diskten kesilir
    const r = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 0, id: 'tt0000044' })
    const j = await waitJob(svc, r.job.id)
    assert.equal(j.state, 'ready', j.error)
    assert.equal(j.source, 'disk')
  })
})

describe('klip: süresi dolan klip açılışta silinir; ffmpeg yoksa kullanılamaz', { skip: NOFF }, () => {
  test('24 saat (sınamada 1 sn) sonra açılışta silinir', async () => {
    const sc = serviceConfig(45, { OFFLINE_FFMPEG: ff.ffmpeg })
    cleanService(sc)
    let svc = await startService(sc)
    const r = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 1 })
    assert.equal((await waitJob(svc, r.job.id)).state, 'ready')
    await svc.stop()
    await sleep(1200)
    const sc2 = serviceConfig(45, { OFFLINE_FFMPEG: ff.ffmpeg, OFFLINE_KLIP_TTL_MS: '1000' })
    svc = await startService(sc2)
    await waitFor(() => !fs.existsSync(path.join(sc.dataDir, 'klipler', r.job.id + '.mkv')), { what: 'süresi dolan klip silindi' })
    assert.equal((await svc.api('GET', '/api/klip')).klips.length, 0)
    await svc.stop()
  })

  test('ffmpeg bulunamazsa düğme kullanılamaz (503)', async () => {
    const sc = serviceConfig(45, { OFFLINE_FFMPEG: path.join(TEST_DIR, 'ffmpeg-yok') })
    const svc = await startService(sc)
    const c = await svc.api('GET', '/api/klip')
    assert.equal(c.available, false)
    assert.ok(c.reason)
    const e = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 0 }).catch(x => x)
    assert.equal(e.status, 503)
    await svc.stop()
  })
})

// ---------------------------------------------------------------- görsel kipi (rastgele sahne görselleri)

test('klip görsel: anlar filme yayılır (%5–%95, her dilimden bir), HDR ton eşleme yalnız PQ/HLG', () => {
  const a = gorselAnlari(1000, 6, () => 0.5)
  assert.equal(a.length, 6)
  for (let k = 0; k < 6; k++) { const dilim = 900 / 6; assert.ok(a[k] >= 50 + dilim * k && a[k] <= 50 + dilim * (k + 1), 'an ' + a[k]) }
  const r = gorselAnlari(7200, 9)
  assert.ok(r.every((x, i) => x >= 360 && x <= 6840 && (i === 0 || x > r[i - 1])), 'sıralı ve aralıkta')
  assert.deepEqual(gorselAnlari(null, 6), [])
  assert.deepEqual(gorselAnlari(100, 0), [])
  assert.equal(hdrMi({ color_transfer: 'smpte2084' }), true)
  assert.equal(hdrMi({ color_transfer: 'arib-std-b67' }), true)
  assert.equal(hdrMi({ color_transfer: 'bt709' }), false)
  assert.equal(hdrMi({}), false)
  const sdr = kareArgs({ input: 'x.mkv', out: 'g1.jpg', at: 12.5, video: { index: 0 } })
  assert.deepEqual(sdr.slice(sdr.indexOf('-ss'), sdr.indexOf('-ss') + 4), ['-ss', '12.5', '-i', 'x.mkv'], 'girdi öncesi -ss')
  assert.ok(sdr.includes('-frames:v') && !sdr.join(' ').includes('tonemap'))
  const hdr = kareArgs({ input: 'http://a/b', out: 'g1.jpg', at: 1, video: { index: 1, color_transfer: 'smpte2084' }, http: true })
  assert.ok(hdr.join(' ').includes('tonemap=tonemap=hable') && hdr.includes('-rw_timeout'))
  assert.deepEqual(hdr.slice(hdr.indexOf('-map'), hdr.indexOf('-map') + 2), ['-map', '0:1'])
})

describe('klip görsel kipi: akıştan rastgele sahne görselleri', { skip: NOFF }, () => {
  const sc = serviceConfig(47, { OFFLINE_FFMPEG: ff.ffmpeg, OFFLINE_METADATA_TIMEOUT: '8' })
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop() })

  test('ayar görsel kipindeyken: 6 JPEG, galeri adresleri, kütüphaneye eklenmez; video klibiyle karışmaz', async () => {
    let c = await svc.api('GET', '/api/klip')
    assert.equal(c.mode, 'video')
    await svc.api('POST', '/api/settings', { clipMode: 'gorsel', clipImages: 6 })
    await assert.rejects(svc.api('POST', '/api/settings', { clipMode: 'resim' }), e => e.status === 400)
    c = await svc.api('GET', '/api/klip')
    assert.equal(c.mode, 'gorsel'); assert.equal(c.imageCount, 6)
    const r = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 1, type: 'movie', id: 'tt0000047', title: 'Görsel Sınama' })
    assert.equal(r.job.mode, 'gorsel')
    const j = await waitJob(svc, r.job.id)
    assert.equal(j.state, 'ready', j.error)
    assert.equal(j.images.length, 6)
    assert.equal(j.doneImages, 6)
    assert.ok(j.images.every((g, i) => g.atSec >= 9 && g.atSec <= 171 && (i === 0 || g.atSec > j.images[i - 1].atSec)), 'anlar: ' + j.images.map(g => g.atSec))
    const dir = path.join(sc.dataDir, 'klipler', j.id)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['g1.jpg', 'g2.jpg', 'g3.jpg', 'g4.jpg', 'g5.jpg', 'g6.jpg'])
    const g = await fetch(j.images[0].url)
    assert.equal(g.status, 200)
    assert.equal(g.headers.get('content-type'), 'image/jpeg')
    const b = Buffer.from(await g.arrayBuffer())
    assert.equal(b.readUInt16BE(0), 0xffd8, 'JPEG başlığı')
    assert.equal((await fetch(svc.base + '/api/klip/' + j.id + '/gorsel/7')).status, 404)
    assert.equal((await fetch(svc.base + '/api/klip/' + j.id + '/dosya')).status, 409, 'görsel kipinde video dosyası yok')
    assert.equal((await svc.api('GET', '/api/items')).items.length, 0)
    // Hazır liste ve yeniden istek
    assert.ok((await svc.api('GET', '/api/klip')).klips.some(k => k.id === j.id && k.mode === 'gorsel' && k.images.length === 6))
    assert.equal((await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 1 })).job.id, j.id)
    // Aynı kaynağın video klibi ayrı iş (açık kip isteği ayarı geçer)
    const v = await svc.api('POST', '/api/klip', { infoHash: vid.infoHash, fileIdx: 1, mode: 'video' })
    assert.equal(v.existed, false)
    assert.notEqual(v.job.id, j.id)
    const vj = await waitJob(svc, v.job.id)
    assert.equal(vj.state, 'ready', vj.error)
    assert.equal(vj.mode, 'video')
    // Sil: klasör de gider
    await svc.api('DELETE', '/api/klip/' + j.id)
    assert.ok(!fs.existsSync(dir))
    await assert.rejects(svc.api('GET', '/api/klip/' + j.id), e => e.status === 404)
  })
})
