// inject.js'in saf kısmı (tarayıcısız): sınıf eşleme, adres çözümleme, rozet, oynatıcı adresi, ileti denetimi.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'http://127.0.0.1:11480'
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'inject.js'), 'utf8').replaceAll('__API__', API)
const ctx = { URLSearchParams, TextEncoder, Response, Blob, CompressionStream, DecompressionStream, btoa, atob }
ctx.globalThis = ctx
vm.runInNewContext(src, ctx)
const saf = ctx.__offlineIndirSaf

test('inject: sınıf kökü rastgele ekten bağımsız eşleşir', () => {
  assert.ok(saf.classHas('action-buttons-container-XbKVa', 'action-buttons-container'))
  assert.ok(saf.classHas('foo meta-info-container-ub8AH bar', 'meta-info-container'))
  assert.ok(saf.classHas('seasons-bar-Ma8vp seasons-bar-container-nOZjG', 'seasons-bar'))
  assert.ok(saf.classHas('description-container-_VXZt', 'description-container'))
  assert.ok(!saf.classHas('meta-preview-container-o22hc', 'meta-preview'))
  assert.ok(!saf.classHas('meta-item-link-veMqr', 'meta-item'))
  assert.ok(!saf.classHas('', 'x'))
  assert.ok(!saf.classHas(null, 'x'))
})

test('inject: Stremio adresleri çözülür', () => {
  assert.deepEqual({ ...saf.parseRoute('#/detail/movie/tt1727587/tt1727587') }, { name: 'detail', type: 'movie', id: 'tt1727587', videoId: 'tt1727587', season: null })
  assert.equal(saf.parseRoute('#/detail/series/tt0903747/tt0903747%3A2%3A3').season, 2)
  assert.equal(saf.parseRoute('#/detail/series/tt0903747?season=4').season, 4)
  assert.equal(saf.parseRoute('#/detail/series/tt0903747').season, null)
  assert.equal(saf.parseRoute('#/').name, 'board')
  assert.equal(saf.parseRoute('').name, 'board')
  assert.equal(saf.parseRoute('#/player/abc/x').name, 'player')
  assert.equal(saf.parseRoute('#/library').name, 'library')
  assert.equal(saf.parseRoute('#/detail/channel/abc').name, 'detail-diger') // film/dizi değil: düğme eklenmez
})

test('inject: sezon metni', () => {
  assert.equal(saf.seasonFromText('Sezon 3'), 3)
  assert.equal(saf.seasonFromText('Season 12'), 12)
  assert.equal(saf.seasonFromText('Özel'), 0)
  assert.equal(saf.seasonFromText('Önceki'), null)
})

test('inject: gömülü İndirme Merkezi adresi', () => {
  assert.equal(saf.embedUrl(API, { type: 'movie', id: 'tt1727587' }), API + '/?embed=1#/surum/movie/tt1727587')
  assert.equal(saf.embedUrl(API, { type: 'series', id: 'tt0903747', season: 2 }), API + '/?embed=1#/sezon/tt0903747/2')
  assert.equal(saf.embedUrl(API, { type: 'series', id: 'tt0903747', season: 0 }), API + '/?embed=1#/sezon/tt0903747/0')
  assert.equal(saf.embedUrl(API, { type: 'series', id: 'tt0903747', season: null }), API + '/?embed=1#/dizi/tt0903747')
})

test('inject: kütüphane özeti ve rozet', () => {
  const play = API + '/play/movie/tt1727587/' + 'a'.repeat(40) + '/5'
  const idx = saf.offlineIndex([
    { state: 'completed', type: 'movie', imdbId: 'tt1727587', displayName: 'Sintel', files: [
      { idx: 1, name: 'extra.mkv', selected: true, complete: true, length: 10, videoId: 'tt1727587:extra', playUrl: 'x' },
      { idx: 5, name: 'Sintel.mp4', selected: true, complete: true, length: 5, videoId: 'tt1727587', playUrl: play },
      { idx: 6, name: 'sec.mkv', selected: false, complete: false, length: 99 }] },
    { state: 'downloading', type: 'series', imdbId: 'tt0903747', files: [
      { idx: 0, selected: true, complete: true, length: 100, doneBytes: 100, videoId: 'tt0903747:1:1', playUrl: 'p1' },
      { idx: 1, selected: true, complete: false, length: 100, doneBytes: 25, videoId: 'tt0903747:1:2' },
      { idx: 2, selected: true, complete: false, length: 100, doneBytes: 50, videoId: 'tt0903747:1:3' }] },
    { state: 'resolving', type: 'movie', imdbId: 'tt0000001', files: [] },
    { state: 'paused', type: 'movie', imdbId: 'tt0000002', files: [{ idx: 0, selected: true, complete: false, length: 10, doneBytes: 5, videoId: 'tt0000002' }] }
  ])
  const m = idx.get('tt1727587')
  assert.equal(m.done, 2)
  assert.equal(m.play.playUrl, play, 'filmin kendi kimliğine eşlenen dosya tercih edilir')
  assert.equal(m.play.fileName, 'Sintel.mp4')
  assert.deepEqual({ ...saf.badgeInfo(m) }, { kind: 'done', text: '✓ Offline' })
  const s = idx.get('tt0903747')
  assert.equal(s.done, 1)
  assert.equal(s.active, 2)
  assert.equal(saf.badgeInfo(s).text, '✓ 1 bölüm offline')
  assert.deepEqual({ ...saf.badgeInfo({ type: 'series', done: 0, active: 2, doneBytes: 75, sizeBytes: 200 }) }, { kind: 'active', text: '⬇ İniyor %37' })
  assert.equal(saf.badgeInfo(idx.get('tt0000001')).kind, 'active')
  assert.equal(saf.badgeInfo(idx.get('tt0000002')), null, 'duraklatılmış ve bitmemiş: rozet yok')
  assert.equal(saf.badgeInfo(undefined), null)
})

test('inject: oynatıcı adresi Stremio biçiminde ve akış geri çözülür', async () => {
  const d = { playUrl: API + '/play/movie/tt1727587/' + 'a'.repeat(40) + '/5', fileName: 'Sintel.mkv', type: 'movie', imdbId: 'tt1727587', videoId: 'tt1727587', title: 'Sintel' }
  const stream = saf.streamFor(d)
  assert.equal(stream.url, d.playUrl)
  assert.equal(stream.behaviorHints.notWebReady, true)
  assert.equal(stream.behaviorHints.filename, 'Sintel.mkv')
  const enc = await saf.encodeStream(stream)
  assert.equal(atob(enc).charCodeAt(0), 0x78, 'zlib başlığı (78 xx), Stremio\'nunkiyle aynı biçim')
  const hash = saf.playerHash(enc, API, d)
  const p = hash.split('/')
  assert.equal(p[1], 'player')
  assert.equal(decodeURIComponent(p[3]), API + '/manifest.json')
  assert.equal(decodeURIComponent(p[4]), API + '/manifest.json')
  assert.deepEqual(p.slice(5), ['movie', 'tt1727587', 'tt1727587'])
  assert.equal(JSON.stringify(await saf.decodeStream(p[2])), JSON.stringify(stream))

  const ep = saf.playerHash(enc, API, { type: null, imdbId: 'tt0903747', videoId: 'tt0903747:1:2' })
  assert.deepEqual(ep.split('/').slice(5).map(decodeURIComponent), ['series', 'tt0903747', 'tt0903747:1:2'])
  assert.equal(saf.playerHash(enc, API, { videoId: null }), '#/player/' + encodeURIComponent(enc))
})

test('inject: yalnızca servisten gelen ve geçerli iletiler kabul edilir', () => {
  const item = { playUrl: API + '/play/movie/tt1/' + 'a'.repeat(40) + '/0' }
  assert.ok(saf.isHostMessage({ source: 'offline-indir', type: 'kapat' }, API, API))
  assert.ok(saf.isHostMessage({ source: 'offline-indir', type: 'oynat', item }, API, API))
  assert.ok(!saf.isHostMessage({ source: 'offline-indir', type: 'kapat' }, 'https://kotu.example', API))
  assert.ok(!saf.isHostMessage({ source: 'baska', type: 'kapat' }, API, API))
  assert.ok(!saf.isHostMessage({ source: 'offline-indir', type: 'oynat', item: { playUrl: 'https://kotu.example/x' } }, API, API))
  assert.ok(!saf.isHostMessage({ source: 'offline-indir', type: 'sil' }, API, API))
  assert.ok(!saf.isHostMessage('kapat', API, API))
})
