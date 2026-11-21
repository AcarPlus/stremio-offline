// Bitince paylaşım (seed): Ayarlar'da kapalı / açık / sınırlı. Yerel döngü, internetsiz.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startSeeder, startService, serviceConfig, cleanService, startRqbit, engineOf, waitFor, sleep, rq, killAll, TEST_DIR, PORTS } from './harness.mjs'

let seed, fx
before(async () => { seed = await startSeeder(); fx = seed.fx })
after(() => { killAll() })

describe('paylaşım (seed) ayarı', () => {
  const sc = serviceConfig(30)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop() })

  test('varsayılan kapalı; geçersiz kip ve sınır reddedilir', async () => {
    const s = await svc.api('GET', '/api/settings')
    assert.equal(s.seedMode, 'kapali')
    assert.equal(s.seedLimit, 100000)
    await assert.rejects(svc.api('POST', '/api/settings', { seedMode: 'hep' }), e => e.status === 400)
    await assert.rejects(svc.api('POST', '/api/settings', { seedLimit: 5 }), e => e.status === 400)
    const r = await svc.api('POST', '/api/settings', { seedMode: 'sinirli', seedLimit: 50000 })
    assert.equal(r.seedMode, 'sinirli')
    assert.equal(r.seedLimit, 50000)
  })

  test('sınırlı kipte bitince süreç açık kalır, yükleme seedLimit ile sınırlı, başka eş veri alır', async () => {
    const ih = fx.film.infoHash
    await svc.api('POST', '/api/items', { infoHash: ih, files: [0], type: 'movie', id: 'tt0000001' })
    const done = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 60000, what: 'tamamlandı' })
    assert.equal(done.percent, 100)
    const eng = await waitFor(async () => { const i = await svc.item(ih); const e = await engineOf(svc, ih); return i.seeding && e }, { timeout: 10000, what: 'paylaşım sürüyor' })
    const lim = await waitFor(async () => { const l = await rq(eng.base, 'GET', '/torrents/limits'); return l.upload_bps === 50000 && l }, { timeout: 10000, what: 'yükleme sınırı seedLimit' })
    assert.equal(lim.upload_bps, 50000)
    // Yalnız bu servisi tanıyan eş: veri almalı (paylaşım gerçekten sürüyor)
    const leech = await startRqbit({ name: 'leech-seed', api: PORTS.leech, port: PORTS.leech + 1, out: path.join(TEST_DIR, 'leech-seed-out') })
    try {
      await rq(leech.base, 'POST', `/torrents?overwrite=true&initial_peers=127.0.0.1:${eng.peerPort}`, fx.film.torrent)
      await waitFor(async () => (await rq(leech.base, 'GET', `/torrents/${ih}/stats/v1`)).progress_bytes > 0, { timeout: 20000, what: 'eş veri aldı' })
    } finally { leech.stop() }
    const v = await svc.item(ih)
    assert.equal(v.seeding, true)
  })

  test('kapalıya alınınca paylaşım durur, süreç kapanır, öğe tamamlanmış kalır', async () => {
    const ih = fx.film.infoHash
    const r = await svc.api('POST', '/api/settings', { seedMode: 'kapali' })
    assert.equal(r.seedMode, 'kapali')
    await waitFor(async () => (await engineOf(svc, ih)) === null, { timeout: 5000, what: 'süreç kapandı' })
    const i = await svc.item(ih)
    assert.equal(i.state, 'completed')
    assert.equal(i.seeding, false)
    assert.equal(i.uploadSpeed, 0)
  })

  test('servis yeniden açılınca paylaşım sürmez (yeniden doğrulama yükü yok)', async () => {
    const ih = fx.film.infoHash
    await svc.api('DELETE', `/api/items/${ih}`)
    await svc.api('POST', '/api/settings', { seedMode: 'acik' })
    await svc.api('POST', '/api/items', { infoHash: ih, files: [0], type: 'movie', id: 'tt0000001' })
    await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i.seeding }, { timeout: 60000, what: 'açık kipte paylaşılıyor' })
    await svc.stop()
    svc = await startService(sc)
    await sleep(1500)
    const i = await svc.item(ih)
    assert.equal(i.state, 'completed')
    assert.equal(i.seeding, false)
    assert.equal(await engineOf(svc, ih), null)
  })
})
