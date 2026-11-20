// İndirme başına hız sınırı: her indirme kendi rqbit sürecinde; sınır çalışırken değişir, kalıcıdır.
// Yerel döngü, internetsiz. Ölçüm: motorun progress_bytes artışı (bayt/sn).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  startSeeder, startService, serviceConfig, cleanService, engineOf, measureRate, waitFor, sleep, rq, killAll, alive, MiB
} from './harness.mjs'

let seed, fx
before(async () => { seed = await startSeeder(); fx = seed.fx })
after(() => { killAll() })

const mib = n => (n / MiB).toFixed(2) + ' MiB/s'
const engineLimits = async (svc, ih) => rq((await engineOf(svc, ih)).base, 'GET', '/torrents/limits')

// Genel ayarlar (Ayarlar sayfası) kurallar.test.mjs'de; burada yalnız hız sınırı alanları karşılaştırılır
const eski = s => ({ defaultDownloadLimit: s.defaultDownloadLimit, uploadLimit: s.uploadLimit, priorityThrottle: s.priorityThrottle, downloadDir: s.downloadDir, autoUpdateCheck: s.autoUpdateCheck })

describe('indirme başına hız sınırı', () => {
  // Varsayılan sınır harness'tan 4 MiB/s (OFFLINE_RATELIMIT_DOWN); yükleme sınırı varsayılanı 100 KB/sn.
  const sc = serviceConfig(6)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop(); cleanService(sc) })

  test('iki indirme ayrı süreçlerde, farklı sınırlarla aynı anda ilerler; sınır canlı değişir', async () => {
    const film = fx.film.infoHash
    const pack = fx.pack.infoHash
    const a = await svc.api('POST', '/api/items', { infoHash: film, files: [0], type: 'movie', id: 'tt0000001' })
    assert.equal(a.item.downloadLimit, 4 * MiB, 'yeni indirme varsayılan sınırı alır')
    await svc.api('POST', '/api/items', { infoHash: pack, files: [0, 2, 3], type: 'series', id: 'tt0000002:1:1' })
    await waitFor(async () => (await svc.item(film)).state === 'downloading' && (await svc.item(pack)).state === 'downloading', { what: 'ikisi de iniyor' })
    const ef = await engineOf(svc, film)
    const ep = await engineOf(svc, pack)
    assert.ok(ef.pid !== ep.pid && ef.apiPort !== ep.apiPort && ef.peerPort !== ep.peerPort, 'ayrı süreç ve kapılar')
    // Canlı değişiklik: süreç yeniden başlatılmadan
    const f = await svc.api('POST', `/api/items/${film}/limit`, { downloadLimit: 1 * MiB })
    assert.equal(f.downloadLimit, 1 * MiB)
    await svc.api('POST', `/api/items/${pack}/limit`, { downloadLimit: 2 * MiB })
    assert.deepEqual(await engineLimits(svc, film), { download_bps: 1 * MiB, upload_bps: 100000 })
    assert.deepEqual(await engineLimits(svc, pack), { download_bps: 2 * MiB, upload_bps: 100000 })
    assert.equal((await engineOf(svc, film)).pid, ef.pid, 'süreç yeniden başlatılmadı')
    await sleep(1500)
    const [rf, rp] = await Promise.all([measureRate(svc, film, 4000), measureRate(svc, pack, 4000)])
    console.log(`  film (1 MiB/s sınır): ${mib(rf)}, paket (2 MiB/s sınır): ${mib(rp)}`)
    assert.ok(rf > 0.6 * MiB && rf < 1.4 * MiB, 'film ~1 MiB/s: ' + mib(rf))
    assert.ok(rp > 1.4 * MiB && rp < 2.6 * MiB, "paket ~2 MiB/s: " + mib(rp))
    assert.ok(rp > 1.5 * rf, "iki indirme farklı hızda")
  })

  test('sınır yeniden başlatmada korunur (indirme başına, kalıcı)', async () => {
    await svc.stop()
    svc = await startService(sc)
    const film = fx.film.infoHash
    const pack = fx.pack.infoHash
    assert.equal((await svc.item(film)).downloadLimit, 1 * MiB)
    assert.equal((await svc.item(pack)).downloadLimit, 2 * MiB)
    await waitFor(async () => (await engineOf(svc, film))?.ready && (await engineOf(svc, pack))?.ready, { what: 'motorlar yeniden başladı' })
    assert.equal((await engineLimits(svc, film)).download_bps, 1 * MiB, 'başlatma bayrağıyla verildi')
    assert.equal((await engineLimits(svc, pack)).download_bps, 2 * MiB)
    await waitFor(async () => (await svc.item(film)).state === 'downloading' && (await svc.item(film)).engineState === 'live', { what: 'film yeniden iniyor' })
    await sleep(1000)
    const rf = await measureRate(svc, film, 3000)
    console.log(`  yeniden başlatma sonrası film: ${mib(rf)}`)
    assert.ok(rf < 1.4 * MiB, 'yeniden başlatma sonrası da ~1 MiB/s: ' + mib(rf))
  })

  test('sınırsız (0) ve geçersiz değerler', async () => {
    const film = fx.film.infoHash
    // Paket sonraki sınama için hâlâ insin diye yavaşlatılır
    await svc.api('POST', `/api/items/${fx.pack.infoHash}/limit`, { downloadLimit: MiB / 2 })
    await svc.api('POST', `/api/items/${film}/limit`, { downloadLimit: 0 })
    assert.equal((await engineLimits(svc, film)).download_bps, null, 'sınırsız = null')
    for (const v of [-1, 'abc', 1.5e10, null]) {
      await assert.rejects(svc.api('POST', `/api/items/${film}/limit`, { downloadLimit: v }), e => e.status === 400, String(v))
    }
    await assert.rejects(svc.api('POST', `/api/items/${film}/limit`, {}), e => e.status === 400)
    await assert.rejects(svc.api('POST', `/api/items/${'e'.repeat(40)}/limit`, { downloadLimit: 0 }), e => e.status === 404)
    await assert.rejects(svc.api('POST', '/api/settings', { uploadLimit: -5 }), e => e.status === 400)
    await waitFor(async () => (await svc.item(film)).state === 'completed', { timeout: 60000, what: 'film sınırsız bitti' })
  })

  test('ayarlar: varsayılan sınır, yükleme sınırı (bütün süreçlere), hepsine uygula; kalıcı', async () => {
    const pack = fx.pack.infoHash
    const s0 = await svc.api('GET', '/api/settings')
    assert.deepEqual(eski(s0), { defaultDownloadLimit: 4 * MiB, uploadLimit: 100000, priorityThrottle: 200000, downloadDir: sc.downloadDir, autoUpdateCheck: true })
    const s1 = await svc.api('POST', '/api/settings', { defaultDownloadLimit: 2 * MiB, uploadLimit: 50000, priorityThrottle: 200000 })
    assert.deepEqual(eski(s1), { defaultDownloadLimit: 2 * MiB, uploadLimit: 50000, priorityThrottle: 200000, downloadDir: sc.downloadDir, autoUpdateCheck: true })
    // Yükleme sınırı çalışan süreçlere hemen; indirme sınırı (kayıtlı) değişmez
    assert.deepEqual(await engineLimits(svc, pack), { download_bps: MiB / 2, upload_bps: 50000 })
    assert.equal((await svc.api('GET', '/api/status')).settings.uploadLimit, 50000)
    // Hepsine uygula
    await svc.api('POST', '/api/settings', { applyToAll: true })
    assert.equal((await svc.item(pack)).downloadLimit, 2 * MiB)
    assert.equal((await svc.item(fx.film.infoHash)).downloadLimit, 2 * MiB, 'bitmiş öğenin kaydı da güncellenir')
    assert.equal((await engineLimits(svc, pack)).download_bps, 2 * MiB)
    // Kalıcı: ayarlar data/ayarlar.json'da
    await svc.stop()
    svc = await startService(sc)
    const kalici = await svc.api('GET', '/api/settings')
    assert.deepEqual({ defaultDownloadLimit: kalici.defaultDownloadLimit, uploadLimit: kalici.uploadLimit, priorityThrottle: kalici.priorityThrottle, downloadDir: kalici.downloadDir, autoUpdateCheck: kalici.autoUpdateCheck },
      { defaultDownloadLimit: 2 * MiB, uploadLimit: 50000, priorityThrottle: 200000, downloadDir: sc.downloadDir, autoUpdateCheck: true })
    assert.ok(fs.existsSync(path.join(sc.dataDir, 'ayarlar.json')))
    // Yeni indirme yeni varsayılanı alır
    const k = await svc.api('POST', '/api/items', { infoHash: fx.klip.infoHash, files: [0], type: 'movie', id: 'tt0000004' })
    assert.equal(k.item.downloadLimit, 2 * MiB)
    await waitFor(async () => (await engineOf(svc, fx.klip.infoHash))?.ready, { what: 'klip motoru' })
    assert.deepEqual(await engineLimits(svc, fx.klip.infoHash), { download_bps: 2 * MiB, upload_bps: 50000 })
  })

  test('kapanışta bütün motor süreçleri kapanır', async () => {
    const pids = (await svc.api('GET', '/api/engines')).engines.map(e => e.pid)
    assert.ok(pids.length >= 1)
    await svc.stop()
    for (const pid of pids) assert.ok(!alive(pid), 'kapandı: ' + pid)
    svc = null
  })
})
