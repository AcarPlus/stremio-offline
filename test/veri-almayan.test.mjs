// Veri almayan öncelikli indirme kimseyi kısmaz (H1). Öbürleri yalnız ★ indirme gerçekten veri alıyorsa
// (motor canlı, indirilen bayt artıyor) kısılır; kısma başlaması için ilerleme görülmesi yeter, kalkması için
// 20 sn hiç ilerleme olmaması gerekir. Yerel döngü, internetsiz.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Manager } from '../lib/manager.mjs'
import {
  startSeeder, startService, serviceConfig, cleanService, engineOf, engineStats, waitFor, sleep, rq, killAll, silentPeer, PORTS, SEED_PEER, MiB
} from './harness.mjs'

let seed, fx
before(async () => { seed = await startSeeder(); fx = seed.fx })
after(() => { killAll() })

const kb = n => (n / 1e3).toFixed(0) + ' KB/s'
const dlimit = async (svc, ih) => (await rq((await engineOf(svc, ih)).base, 'GET', '/torrents/limits')).download_bps

async function rate (svc, ih, ms) {
  const a = await engineStats(svc, ih)
  const t0 = Date.now()
  await sleep(ms)
  const b = await engineStats(svc, ih)
  return (b.progress_bytes - a.progress_bytes) / ((Date.now() - t0) / 1000)
}

describe('öncelikli indirme veri almıyorsa kimse kısılmaz (H1)', () => {
  // Sessiz eş: bağlanır ama hiç konuşmaz; ★ torrent metadata beklerken takılı kalır
  const sc = serviceConfig(10, { OFFLINE_RATELIMIT_DOWN: String(MiB), OFFLINE_EXTRA_PEERS: `${SEED_PEER},127.0.0.1:${PORTS.silentPeer}` })
  let peer
  let svc
  const ghost = 'ab'.repeat(20) // hiçbir eşi olmayan torrent: metadata hiç gelmez
  before(async () => { cleanService(sc); peer = silentPeer(PORTS.silentPeer); svc = await startService(sc) })
  after(async () => { await svc?.stop(); peer?.close(); cleanService(sc) })

  test('eşsiz ★ indirme varken öbürünün hızı düşmez; ★ veri almaya başlayınca düşer', async () => {
    const pack = fx.pack.infoHash
    const film = fx.film.infoHash
    await svc.api('POST', '/api/items', { infoHash: pack, files: [0, 2, 3], type: 'series', id: 'tt0000002:1:1' })
    await svc.api('POST', '/api/items', { infoHash: ghost, type: 'movie', id: 'tt0000009' })
    await waitFor(async () => (await svc.item(pack)).engineState === 'live', { what: 'paket iniyor' })
    const g = await svc.api('POST', `/api/items/${ghost}/priority`, { priority: true })
    assert.equal(g.priority, true)
    await sleep(2500)
    const gv = await svc.item(ghost)
    assert.equal(gv.priority, true, '★ işareti kalır')
    assert.equal(gv.priorityIdle, true, 'kartta "veri almıyor" notu için alan')
    assert.equal(gv.state, 'resolving')
    const pv = await svc.item(pack)
    assert.equal(pv.throttled, false)
    assert.equal(await dlimit(svc, pack), MiB, 'paket kısılmadı')
    const r0 = await rate(svc, pack, 3000)
    console.log(`  eşsiz ★ varken paket: ${kb(r0)} (kısma hızı 200 KB/s, sınır 1 MiB/s)`)
    assert.ok(r0 > 0.7 * MiB, 'paket tam sınırında: ' + kb(r0))

    // ★ veri alan bir indirmeye verilir: paket kısılır
    await svc.api('POST', '/api/items', { infoHash: film, files: [0], type: 'movie', id: 'tt0000001' })
    await waitFor(async () => (await svc.item(film)).engineState === 'live', { what: 'film iniyor' })
    await svc.api('POST', `/api/items/${film}/priority`, { priority: true })
    await waitFor(async () => (await dlimit(svc, pack)) === 200000, { timeout: 15000, what: 'film veri alınca paket kısıldı' })
    const fv = await svc.item(film)
    assert.equal(fv.priorityIdle, false)
    assert.equal((await svc.item(pack)).throttled, true)
    await sleep(1000)
    const r1 = await rate(svc, pack, 3000)
    console.log(`  ★ film veri alırken paket: ${kb(r1)}`)
    assert.ok(r1 < 500e3 && r1 > 30e3, 'paket kısıldı, durmadı: ' + kb(r1))
    assert.ok(r1 < r0 / 2, 'kısılınca belirgin yavaşladı')
  })
})

// Kısma/kalkma eşikleri: sahte saat ve sahte motor istatistiğiyle (gerçek bekleme yok)
describe('öncelik kısması: veri akışı eşikleri ve salınım önleme (birim)', () => {
  function mk () {
    const items = [
      { infoHash: 'a'.repeat(40), state: 'downloading', inEngine: true, priority: true, downloadLimit: 1000000, live: { engineState: 'live' } },
      { infoHash: 'b'.repeat(40), state: 'downloading', inEngine: true, priority: false, downloadLimit: 1000000, live: { engineState: 'live' } }
    ]
    const lib = { all: () => items, get: ih => items.find(i => i.infoHash === ih), saveNow () {} }
    const settings = { get: () => ({ defaultDownloadLimit: 0, uploadLimit: 0, priorityThrottle: 200000 }) }
    const m = new Manager({ cfg: {}, pool: new EventEmitter(), library: lib, meta: {}, settings })
    let t = 1000000
    m.now = () => t
    return { m, items, tick: ms => { t += ms }, feed: bytes => m.trackFlow(items[0], { progress_bytes: bytes }) }
  }

  test('ilerleme yokken kısma yok; ilerleme görülünce başlar; 20 sn ilerleme olmadan kalkar, 20 sn dolmadan kalkmaz', () => {
    const { m, items, tick, feed } = mk()
    const lim = () => m.effectiveLimit(items[1])
    feed(100) // ilk görüş: yalnızca taban
    assert.equal(lim().throttled, false, 'henüz ilerleme görülmedi')
    tick(1000); feed(100)
    assert.equal(lim().throttled, false, 'bayt artmıyor')
    tick(1000); feed(5000) // veri akışı görüldü
    assert.deepEqual(lim(), { down: 200000, throttled: true })
    // takılma: 19 sn ilerleme yok -> hâlâ kısılı (salınım yok)
    tick(19000); feed(5000)
    assert.equal(lim().throttled, true, '19 sn: kalkmaz')
    // kısa süreli ilerleme sayacı sıfırlar
    tick(1000); feed(9000)
    tick(19000); feed(9000)
    assert.equal(lim().throttled, true, 'ilerleme sayacı yenilendi')
    tick(1500); feed(9000)
    assert.equal(lim().throttled, false, '20 sn ilerleme yok: kalktı')
    assert.equal(lim().down, 1000000)
    // kalktıktan sonra tek bir artış yeniden başlatır
    tick(1000); feed(20000)
    assert.equal(lim().throttled, true)
  })

  test('metadata beklerken (resolving) ya da motor canlı değilken kısma yok; ★ işareti kalır', () => {
    const { m, items, tick, feed } = mk()
    feed(0); tick(500); feed(9000)
    assert.equal(m.effectiveLimit(items[1]).throttled, true)
    items[0].state = 'resolving'
    assert.equal(m.effectiveLimit(items[1]).throttled, false, 'resolving: kısma yok')
    assert.equal(items[0].priority, true)
    assert.equal(m.view(items[0]).priorityIdle, true)
    items[0].state = 'downloading'; items[0].live = { engineState: 'initializing' }
    assert.equal(m.effectiveLimit(items[1]).throttled, false, 'doğrulama sürerken kısma yok')
  })
})
