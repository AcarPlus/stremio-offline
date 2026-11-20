// web/yardimci.js: sürüm seçicideki kalite rozeti (indirmeden tahmini bit hızı) ve addan teknik etiketler.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ctx = {}
ctx.globalThis = ctx
vm.runInNewContext(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'yardimci.js'), 'utf8'), ctx)
const y = ctx.OfflineYardimci
const plain = x => JSON.parse(JSON.stringify(x)) // vm bağlamındaki diziler başka Array.prototype taşır

test('süre: Cinemeta runtime biçimleri', () => {
  assert.equal(y.parseRuntime('2h 10min'), 130)
  assert.equal(y.parseRuntime('130 min'), 130)
  assert.equal(y.parseRuntime('45min'), 45)
  assert.equal(y.parseRuntime('1h'), 60)
  assert.equal(y.parseRuntime('1 h 5 m'), 65)
  assert.equal(y.parseRuntime('2:10'), 130)
  assert.equal(y.parseRuntime('PT1H30M'), 90)
  assert.equal(y.parseRuntime('98'), 98)
  assert.equal(y.parseRuntime('1.5h'), 90)
  assert.equal(y.parseRuntime('N/A'), null)
  assert.equal(y.parseRuntime(''), null)
  assert.equal(y.parseRuntime(null), null)
  assert.equal(y.parseRuntime('0 min'), null)
})

test('bit hızı: boyut ÷ süre, Mbps', () => {
  // 6 GB, 100 dk -> 6e9*8 / 6000 / 1e6 = 8 Mbps
  assert.equal(y.bitrateMbps(6e9, 100), 8)
  assert.equal(y.bitrateMbps(0, 100), null)
  assert.equal(y.bitrateMbps(6e9, null), null)
})

test('rozet: çözünürlüğe göre eşik ve renk', () => {
  const v = (gb, quality, name = 'Film.2020') => ({ sizeBytes: gb * 1e9, quality, name, kind: 'single' })
  // 1080p H.264: <4 düşük, 4–8 orta, >8 iyi
  assert.equal(y.qualityBadge(v(1.5, '1080p'), 120).level, 'dusuk') // 1,67 Mbps
  assert.equal(y.qualityBadge(v(5, '1080p'), 120).level, 'orta') // 5,56
  assert.equal(y.qualityBadge(v(15, '1080p'), 120).level, 'iyi') // 16,7
  // 2160p: <12 / 12–25 / >25
  assert.equal(y.qualityBadge(v(9, '4k'), 120).level, 'dusuk') // 10
  assert.equal(y.qualityBadge(v(15, '2160p'), 120).level, 'orta') // 16,7
  assert.equal(y.qualityBadge(v(60, '2160p'), 120).level, 'iyi') // 66,7
  // 720p: <2 / 2–4 / >4
  assert.equal(y.qualityBadge(v(1, '720p'), 120).level, 'dusuk') // 1,1
  assert.equal(y.qualityBadge(v(2.5, '720p'), 120).level, 'orta')
  assert.equal(y.qualityBadge(v(5, '720p'), 120).level, 'iyi')
  // HEVC eşikleri 0,6 ile: 1080p HEVC 3 Mbps orta (2,4–4,8), H.264 olsa düşük
  assert.equal(y.qualityBadge(v(2.7, '1080p', 'Film.2020.1080p.x265'), 120).level, 'orta')
  assert.equal(y.qualityBadge(v(2.7, '1080p', 'Film.2020.1080p.x264'), 120).level, 'dusuk')
  // Metin: 10 altı bir ondalık, üstü tam sayı (Türkçe ondalık virgül)
  assert.equal(y.qualityBadge(v(5, '1080p'), 120).text, '5,6 Mbps')
  assert.equal(y.qualityBadge(v(15, '1080p'), 120).text, '17 Mbps')
  // Kalite bilinmiyorsa renk yok ama değer var
  const u = y.qualityBadge(v(5, ''), 120)
  assert.equal(u.level, null)
  assert.equal(u.text, '5,6 Mbps')
})

test('rozet: süre yoksa, paket ya da anlamsız boyutta rozet yok', () => {
  assert.equal(y.qualityBadge({ sizeBytes: 5e9, quality: '1080p', kind: 'single' }, null), null)
  assert.equal(y.qualityBadge({ sizeBytes: 0, quality: '1080p', kind: 'single' }, 120), null)
  assert.equal(y.qualityBadge({ sizeBytes: 50e9, quality: '1080p', kind: 'pack' }, 45), null)
  assert.equal(y.qualityBadge({ sizeBytes: 200e9, quality: '1080p', kind: 'collection' }, 100), null, '120 Mbps üstü: büyük olasılıkla koleksiyon boyutu')
})

test('teknik etiketler: codec, HDR, 10bit, ses', () => {
  assert.deepEqual(plain(y.techInfo('Movie.2023.2160p.UHD.BluRay.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos.7.1')),
    { video: 'HEVC', hdr: ['DV', 'HDR10+'], bit10: false, audio: ['Atmos', 'TrueHD'] })
  assert.deepEqual(plain(y.techInfo('Movie 2023 1080p WEB-DL DDP5.1 H.264')), { video: 'AVC', hdr: [], bit10: false, audio: ['DDP'] })
  assert.deepEqual(plain(y.techInfo('Movie.2023.1080p.BluRay.10bit.x265.DTS-HD.MA.5.1')), { video: 'HEVC', hdr: [], bit10: true, audio: ['DTS-HD'] })
  assert.deepEqual(plain(y.techInfo('Movie.2023.1080p.WEBRip.AV1.Opus')), { video: 'AV1', hdr: [], bit10: false, audio: ['Opus'] })
  assert.deepEqual(plain(y.techInfo('Movie.2023.720p.BluRay.x264.AAC5.1')), { video: 'AVC', hdr: [], bit10: false, audio: ['AAC'] })
  assert.deepEqual(plain(y.techInfo('Movie.2023.1080p.BluRay.DD5.1.x264')).audio, ['DD'])
  assert.deepEqual(plain(y.techInfo('Movie.2023.1080p.HDR.DTS.x265')).audio, ['DTS'])
  assert.deepEqual(plain(y.techInfo('Film')), { video: null, hdr: [], bit10: false, audio: [] })
  // Torrentio etiketleriyle tekrarsız birleşim
  assert.deepEqual(plain(y.techTags({ name: 'Movie.2160p.HDR10+.x265.10bit.DDP5.1.Atmos', tags: ['HDR', 'HEVC', 'REMUX'] })),
    ['HEVC', 'HDR10+', 'REMUX', '10bit', 'Atmos', 'DDP'])
})
