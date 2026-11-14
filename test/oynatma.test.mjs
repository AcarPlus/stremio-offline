// Oynatma muafiyeti: akış sunulan indirme kısılmaz ve kendi sınırı askıdadır; son bağlantı kapandıktan
// playGraceMs (testte 3 sn) sonra sınırlar eski hesabına döner. Yerel döngü, internetsiz.
// Hız motorun progress_bytes artışından ölçülür. Tohumlayıcının yükleme hızı 3 MiB/s'ye indirilir ki film
// sınırsızken de saniyeler sürsün (yoksa saniyeler içinde biter ve yeniden kısılma görülemez).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  startSeeder, startService, serviceConfig, cleanService, engineOf, engineStats, waitFor, sleep, rq, killAll, MiB
} from './harness.mjs'

let seed, fx
before(async () => {
  seed = await startSeeder(); fx = seed.fx
  const r = await fetch(seed.base + '/torrents/limits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ download_bps: null, upload_bps: 3 * MiB }) })
  assert.ok(r.ok, 'tohumlayıcı sınırı ayarlanamadı: ' + r.status)
})
after(() => { killAll() })

const kb = n => (n / 1e3).toFixed(0) + ' KB/s'
const dlimit = async (svc, ih) => (await rq((await engineOf(svc, ih)).base, 'GET', '/torrents/limits')).download_bps

/** ms boyunca 150 ms aralıkla örnekler; son geçerli örneğe kadar ortalama bayt/sn. */
async function rate (svc, ih, ms) {
  const a = await engineStats(svc, ih)
  const t0 = Date.now()
  let lastB = a.progress_bytes
  let lastT = t0
  while (Date.now() - t0 < ms) {
    await sleep(150)
    const b = await engineStats(svc, ih).catch(() => null)
    if (!b) break
    lastB = b.progress_bytes; lastT = Date.now()
  }
  return (lastB - a.progress_bytes) / ((lastT - t0) / 1000)
}

describe('oynatılan indirme kısılmaz (H2)', () => {
  const sc = serviceConfig(9, { OFFLINE_RATELIMIT_DOWN: String(MiB), OFFLINE_PLAY_GRACE_MS: '3000' })
  let svc
  const film = () => fx.film.infoHash
  const pack = () => fx.pack.infoHash
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop(); cleanService(sc) })

  test('kısılmış indirmeden akış sürerken hız kısma hızının çok üstünde; bağlantı kapanıp süre dolunca yeniden kısılır', async () => {
    await svc.api('POST', '/api/items', { infoHash: film(), files: [0], type: 'movie', id: 'tt0000001' })
    await svc.api('POST', '/api/items', { infoHash: pack(), files: [0, 2, 3], type: 'series', id: 'tt0000002:1:1' })
    await waitFor(async () => (await svc.item(film())).engineState === 'live' && (await svc.item(pack())).engineState === 'live', { what: 'ikisi iniyor' })
    await svc.api('POST', `/api/items/${pack()}/priority`, { priority: true })
    await waitFor(async () => (await dlimit(svc, film())) === 200000, { timeout: 10000, what: 'film kısıldı' })
    await sleep(1000)
    const r0 = await rate(svc, film(), 3000)
    console.log(`  kısılmış film (akış yok): ${kb(r0)}`)
    assert.ok(r0 < 500e3, 'kısılmış: ' + kb(r0))
    assert.equal((await svc.item(film())).playing, false)

    // Akış aç (uzun Range): okuyucu hızlı okur
    const ac = new AbortController()
    const resp = await fetch(`${svc.base}/play/movie/tt0000001/${film()}/0`, { headers: { Range: 'bytes=0-' }, signal: ac.signal })
    assert.equal(resp.status, 206)
    const reader = resp.body.getReader()
    let reading = true
    const pump = (async () => { try { while (reading) { const { done } = await reader.read(); if (done) break } } catch {} })()
    await waitFor(async () => (await dlimit(svc, film())) === null, { timeout: 5000, what: 'akış sürerken film sınırsız' })
    const v = await svc.item(film())
    assert.equal(v.playing, true)
    assert.equal(v.throttled, false)
    assert.equal(v.effectiveLimit, 0, 'etkin sınır sınırsız')
    assert.equal(v.downloadLimit, MiB, 'kayıtlı sınır değişmez')
    const vp = await svc.item(pack())
    assert.equal(vp.priority, true, 'oynatılan başkasını kısmaz: öncelik işareti yerinde')
    assert.equal(await dlimit(svc, pack()), MiB, 'öncelikli paketin sınırı aynı')
    const r1 = await rate(svc, film(), 2500)
    console.log(`  akış sürerken film: ${kb(r1)} (kısma hızı 200 KB/s)`)
    assert.ok(r1 > 1.2 * MiB, 'kısma hızının belirgin üstünde: ' + kb(r1))

    // Okumayı bırak ama bağlantı açık kalsın: muafiyet süre dolumundan (3 sn) sonra da sürmeli
    reading = false
    await sleep(4500)
    assert.equal(await dlimit(svc, film()), null, 'bağlantı açıkken muafiyet sürer')
    assert.equal((await svc.item(film())).playing, true)

    // Bağlantıyı kapat: 3 sn dolmadan hâlâ muaf, sonra yeniden kısılır
    ac.abort()
    await pump.catch(() => {})
    await sleep(1200)
    assert.equal(await dlimit(svc, film()), null, 'kapanıştan hemen sonra muaf (bekleme süresi)')
    await waitFor(async () => (await dlimit(svc, film())) === 200000, { timeout: 8000, what: 'süre dolunca yeniden kısıldı' })
    const v2 = await svc.item(film())
    assert.equal(v2.playing, false)
    assert.equal(v2.throttled, true)
    assert.equal(v2.downloadLimit, MiB, 'kayıtlı sınır hiç değişmedi')
    await sleep(1000)
    const r2 = await rate(svc, film(), 3000)
    console.log(`  süre dolunca film: ${kb(r2)}`)
    assert.ok(r2 < 500e3, 'yeniden kısıldı: ' + kb(r2))
  })
})
