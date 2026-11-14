// İndirme önceliği: öncelikli indirme kendi sınırıyla sürer, diğer etkin indirmeler kısma hızına iner (durmaz).
// Kayıtlı indirme başına sınır ezilmez (etkin = min(kayıtlı, kısma)); öncelik kalıcıdır. Yerel döngü, internetsiz.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  startSeeder, startService, serviceConfig, cleanService, engineOf, measureRate, waitFor, sleep, rq, killAll, MiB
} from './harness.mjs'

let seed, fx
before(async () => { seed = await startSeeder(); fx = seed.fx })
after(() => { killAll() })

const kb = n => (n / 1e3).toFixed(0) + ' KB/s'
const dlimit = async (svc, ih) => (await rq((await engineOf(svc, ih)).base, 'GET', '/torrents/limits')).download_bps

describe('indirme önceliği', () => {
  // Varsayılan sınır 1 MiB/s (film 48 MiB, ~48 sn sürer); kısma hızı varsayılanı 200 KB/sn.
  const sc = serviceConfig(8, { OFFLINE_RATELIMIT_DOWN: String(MiB) })
  let svc
  const film = () => fx.film.infoHash
  const pack = () => fx.pack.infoHash
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop(); cleanService(sc) })

  test('öncelik verilince diğeri kısma hızına iner (durmaz), kayıtlı sınırı değişmez', async () => {
    await svc.api('POST', '/api/items', { infoHash: film(), files: [0], type: 'movie', id: 'tt0000001' })
    await svc.api('POST', '/api/items', { infoHash: pack(), files: [0, 2, 3], type: 'series', id: 'tt0000002:1:1' })
    await waitFor(async () => { const a = await svc.item(film()); const b = await svc.item(pack()); return a.engineState === 'live' && b.engineState === 'live' }, { what: 'ikisi iniyor' })
    const r = await svc.api('POST', `/api/items/${film()}/priority`, { priority: true })
    assert.equal(r.priority, true)
    assert.equal(r.throttled, false)
    assert.equal(await dlimit(svc, pack()), 200000, 'diğerinin motoru kısma hızında')
    assert.equal(await dlimit(svc, film()), MiB, 'öncelikli kendi sınırında')
    const p = await svc.item(pack())
    assert.equal(p.downloadLimit, MiB, 'kayıtlı sınır değişmez')
    assert.equal(p.throttled, true)
    assert.equal(p.effectiveLimit, 200000)
    await sleep(1000)
    const [rf, rp] = await Promise.all([measureRate(svc, film(), 4000), measureRate(svc, pack(), 4000)])
    console.log(`  öncelikli film: ${kb(rf)}, kısılan paket: ${kb(rp)}`)
    assert.ok(rp > 50e3 && rp < 320e3, 'paket ~200 KB/s, durmadı: ' + kb(rp))
    assert.ok(rf > 0.7 * MiB, 'film tam hız: ' + kb(rf))
  })

  test('başkası öncelikli yapılınca önceki önceliğini kaybeder; kaldırılınca herkes kendi sınırına döner', async () => {
    const r = await svc.api('POST', `/api/items/${pack()}/priority`, { priority: true })
    assert.equal(r.priority, true)
    assert.equal((await svc.item(film())).priority, false, 'en çok bir öncelikli')
    assert.equal(await dlimit(svc, film()), 200000)
    assert.equal(await dlimit(svc, pack()), MiB)
    await svc.api('POST', `/api/items/${pack()}/priority`, { priority: false })
    assert.equal(await dlimit(svc, film()), MiB)
    assert.equal(await dlimit(svc, pack()), MiB)
    assert.equal((await svc.item(film())).throttled, false)
    await sleep(1000)
    const rp = await measureRate(svc, pack(), 3000)
    console.log(`  öncelik kaldırılınca paket: ${kb(rp)}`)
    assert.ok(rp > 0.7 * MiB, 'paket kendi sınırına döndü: ' + kb(rp))
    // Kayıtlı sınır kısma hızından düşükse etkin sınır kayıtlı olandır (min)
    await svc.api('POST', `/api/items/${pack()}/limit`, { downloadLimit: 100000 })
    await svc.api('POST', `/api/items/${film()}/priority`, { priority: true })
    assert.equal(await dlimit(svc, pack()), 100000)
    assert.equal((await svc.item(pack())).throttled, false)
    await svc.api('POST', `/api/items/${pack()}/limit`, { downloadLimit: MiB })
    assert.equal(await dlimit(svc, pack()), 200000)
    await assert.rejects(svc.api('POST', `/api/items/${film()}/priority`, {}), e => e.status === 400)
  })

  test('öncelik yeniden başlatmada korunur', async () => {
    await svc.stop()
    svc = await startService(sc)
    assert.equal((await svc.item(film())).priority, true)
    await waitFor(async () => (await engineOf(svc, pack()))?.ready && (await engineOf(svc, film()))?.ready, { what: 'motorlar' })
    await waitFor(async () => (await dlimit(svc, pack())) === 200000, { timeout: 5000, what: 'paket yeniden başlatmada da kısık' })
    assert.equal(await dlimit(svc, film()), MiB)
  })

  test('öncelikli duraklatılınca diğeri döner, sürdürülünce yine kısılır; bitince öncelik kalkar', async () => {
    await svc.api('POST', `/api/items/${film()}/pause`)
    assert.equal(await dlimit(svc, pack()), MiB, 'tek etkin indirme kısılmaz')
    assert.equal((await svc.item(film())).priority, true, 'duraklatınca işaret kalır')
    await svc.api('POST', `/api/items/${film()}/resume`)
    await waitFor(async () => (await dlimit(svc, pack())) === 200000, { timeout: 10000, what: 'sürdürünce yine kısıldı' })
    // Film sınırsız yapılıp bitirilir: öncelik kalkar, paket kendi sınırına döner
    await svc.api('POST', `/api/items/${film()}/limit`, { downloadLimit: 0 })
    await waitFor(async () => (await svc.item(film())).state === 'completed', { timeout: 60000, what: 'film bitti' })
    assert.equal((await svc.item(film())).priority, false)
    await waitFor(async () => (await dlimit(svc, pack())) === MiB, { timeout: 5000, what: 'paket kendi sınırına döndü' })
    assert.equal((await svc.item(pack())).throttled, false)
    await assert.rejects(svc.api('POST', `/api/items/${film()}/priority`, { priority: true }), e => e.status === 409)
  })

  test('öncelikli silinince diğerleri döner; kısma hızı ayarlanır ve kalıcıdır', async () => {
    await svc.api('POST', '/api/items', { infoHash: fx.klip.infoHash, files: [0], type: 'movie', id: 'tt0000004' })
    await waitFor(async () => (await engineOf(svc, fx.klip.infoHash))?.ready, { what: 'klip motoru' })
    await svc.api('POST', `/api/items/${fx.klip.infoHash}/priority`, { priority: true })
    assert.equal(await dlimit(svc, pack()), 200000)
    const s = await svc.api('POST', '/api/settings', { priorityThrottle: 300000 })
    assert.equal(s.priorityThrottle, 300000)
    assert.equal(await dlimit(svc, pack()), 300000, 'yeni kısma hızı hemen uygulanır')
    await svc.api('POST', `/api/items/${fx.klip.infoHash}/cancel`)
    await waitFor(async () => (await dlimit(svc, pack())) === MiB, { timeout: 5000, what: 'silinince paket döndü' })
    await svc.stop()
    svc = await startService(sc)
    assert.equal((await svc.api('GET', '/api/settings')).priorityThrottle, 300000)
  })
})
