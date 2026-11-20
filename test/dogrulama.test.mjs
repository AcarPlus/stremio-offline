// H3/H4: ayar ve sınır girişi katı doğrulanır; geçersiz gövde hiçbir alanı uygulamaz; applyToAll yalnız true.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startService, serviceConfig, cleanService, killAll } from './harness.mjs'

after(() => { killAll() })

describe('sınır ve ayar doğrulaması', () => {
  const sc = serviceConfig(11, { OFFLINE_RATELIMIT_DOWN: '2000000' })
  const ih = 'cd'.repeat(20)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc); await svc.api('POST', '/api/items', { infoHash: ih, type: 'movie', id: 'tt0000009' }) })
  after(async () => { await svc?.stop(); cleanService(sc) })
  const file = () => path.join(sc.dataDir, 'ayarlar.json')

  test('geçersiz alan varsa hiçbiri uygulanmaz (bellekte, diskte, öğelerde)', async () => {
    const s0 = await svc.api('GET', '/api/settings')
    for (const bad of [
      { defaultDownloadLimit: 123456, uploadLimit: -1 },
      { defaultDownloadLimit: 123456, priorityThrottle: 'abc', applyToAll: true },
      { uploadLimit: 60000, defaultDownloadLimit: 500 },
      { maxConcurrent: 2, scheduleStart: '7:00' },
      { showBadges: false, clipSeconds: 45 }
    ]) {
      await assert.rejects(svc.api('POST', '/api/settings', bad), e => e.status === 400, JSON.stringify(bad))
      assert.deepEqual(await svc.api('GET', '/api/settings'), s0, 'ayarlar değişmedi: ' + JSON.stringify(bad))
    }
    assert.ok(!fs.existsSync(file()), 'diske yazılmadı')
    assert.equal((await svc.item(ih)).downloadLimit, 2000000, 'applyToAll uygulanmadı')
    // Hepsi geçerliyse hepsi uygulanır
    const s1 = await svc.api('POST', '/api/settings', { defaultDownloadLimit: 123456, uploadLimit: 0, priorityThrottle: 1000 })
    assert.deepEqual({ defaultDownloadLimit: s1.defaultDownloadLimit, uploadLimit: s1.uploadLimit, priorityThrottle: s1.priorityThrottle, downloadDir: s1.downloadDir, autoUpdateCheck: s1.autoUpdateCheck },
      { defaultDownloadLimit: 123456, uploadLimit: 0, priorityThrottle: 1000, downloadDir: sc.downloadDir, autoUpdateCheck: true })
    assert.equal(JSON.parse(fs.readFileSync(file(), 'utf8')).defaultDownloadLimit, 123456)
  })

  test('sınır katı: yalnız sayı, tam sayı, 0 ya da 1000..4294967295', async () => {
    const post = v => svc.api('POST', `/api/items/${ih}/limit`, { downloadLimit: v })
    for (const v of [true, false, [], ' ', '0x10', '1e3', '5000', '0', 1.5, 1e-9, [5], 999, 1, -1, 4294967296, null, {}, 'abc']) {
      await assert.rejects(post(v), e => e.status === 400, 'reddedilmeli: ' + JSON.stringify(v))
    }
    assert.equal((await svc.item(ih)).downloadLimit, 2000000, 'reddedilenler değeri değiştirmedi')
    for (const v of [0, 1000, 4294967295, 750000]) assert.equal((await post(v)).downloadLimit, v)
    // Ayar alanları da aynı kuralla
    for (const k of ['defaultDownloadLimit', 'uploadLimit', 'priorityThrottle']) {
      for (const v of [true, '5000', 1.5, 1e-9, 999, null, [5]]) await assert.rejects(svc.api('POST', '/api/settings', { [k]: v }), e => e.status === 400, k + '=' + JSON.stringify(v))
    }
  })

  test('applyToAll yalnız true', async () => {
    await svc.api('POST', `/api/items/${ih}/limit`, { downloadLimit: 750000 })
    for (const v of ['true', 'false', 1, 'yes', [], {}]) {
      await svc.api('POST', '/api/settings', { applyToAll: v })
      assert.equal((await svc.item(ih)).downloadLimit, 750000, 'uygulanmadı: ' + JSON.stringify(v))
    }
    await svc.api('POST', '/api/settings', { applyToAll: true })
    assert.equal((await svc.item(ih)).downloadLimit, 123456, 'true: varsayılan bütün öğelere yazıldı')
  })
})
