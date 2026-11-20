// "Hepsi bitince bilgisayarı kapat": GÜVENLİK sınamaları dahil. Bu dosyada gerçek shutdown.exe ASLA çalışmaz:
// birimlerde komut çalıştırıcı sahtedir, servis sınamalarında OFFLINE_KAPATMA_KOMUTU sahte bir betiğe işaret eder
// ya da (sınama kipinde) hiç verilmez ve hiçbir şey çalışmaz.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSeeder, startService, serviceConfig, cleanService, waitFor, sleep, killAll, TEST_DIR } from './harness.mjs'
import { Kapatma, komutBul, GERI_SAYIM_SN } from '../lib/kapat.mjs'

const mk = (items, cfg = {}) => {
  const calls = []
  const manager = { lib: { all: () => items } }
  const k = new Kapatma({ cfg: { testMode: true, shutdownCmd: 'sahte-program', shutdownCheckMs: 10, ...cfg }, manager, run: async (p, a) => { calls.push([p, a]); return { code: 0, stderr: '' } } })
  return { k, calls, items }
}

describe('Kapatma (birim)', () => {
  test('komutBul: sınama kipinde değişken yoksa komut YOK; değişken varsa o; gerçekte shutdown.exe', () => {
    assert.equal(komutBul({ testMode: true, shutdownCmd: null }), null)
    assert.equal(komutBul({ testMode: true, shutdownCmd: 'x.mjs' }), 'x.mjs')
    assert.match(komutBul({ testMode: false, shutdownCmd: null }), /shutdown\.exe$/i)
  })

  test('etkin indirme yokken anahtar açılmaz (409)', () => {
    const { k } = mk([{ state: 'completed', completedAt: 1 }, { state: 'paused' }])
    assert.throws(() => k.arm(), e => e.status === 409 && /Etkin indirme yok/.test(e.message))
    assert.equal(k.durum().armed, false)
  })

  test('etkin indirmeler bitince (2 ardışık gözlem) /s /t 60 /c ile tetiklenir; duraklatılmışlar sayılmaz', async () => {
    const items = [{ state: 'downloading' }, { state: 'paused' }, { state: 'error' }]
    const { k, calls } = mk(items)
    k.arm()
    assert.equal(k.durum().armed, true)
    await k.tick(); assert.equal(calls.length, 0)
    items[0].state = 'completed'; items[0].completedAt = Date.now() + 5
    await k.tick(); assert.equal(calls.length, 0, 'tek gözlem yetmez')
    await k.tick()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0][1].slice(0, 3), ['/s', '/t', String(GERI_SAYIM_SN)])
    assert.equal(calls[0][1][3], '/c')
    const d = k.durum()
    assert.equal(d.countdown, true)
    assert.ok(d.secondsLeft > 55 && d.secondsLeft <= 60)
    await k.tick(); assert.equal(calls.length, 1, 'geri sayımda yeniden tetiklenmez')
    // İptal: shutdown /a
    const r = await k.disarm()
    assert.deepEqual(calls[1][1], ['/a'])
    assert.equal(r.countdown, false); assert.equal(r.armed, false)
    k.stop()
  })

  test('geri sayımda yeni indirme başlarsa kapatma kendiliğinden iptal edilir (/a)', async () => {
    const items = [{ state: 'downloading' }]
    const { k, calls } = mk(items)
    k.arm()
    items[0].state = 'completed'; items[0].completedAt = Date.now() + 5
    await k.tick(); await k.tick()
    assert.equal(k.durum().countdown, true)
    items.push({ state: 'resolving' })
    await k.tick()
    assert.deepEqual(calls.at(-1)[1], ['/a'])
    const d = k.durum()
    assert.equal(d.countdown, false); assert.equal(d.armed, false)
    assert.match(d.message, /yeni bir indirme/)
    k.stop()
  })

  test('hiçbiri tamamlanmadan etkin kalmazsa (duraklat/iptal) KAPATMAZ ve anahtar kapanır', async () => {
    const items = [{ state: 'downloading' }]
    const { k, calls } = mk(items)
    k.arm()
    items[0].state = 'paused'
    await k.tick(); await k.tick(); await k.tick()
    assert.equal(calls.length, 0)
    const d = k.durum()
    assert.equal(d.armed, false)
    assert.match(d.message, /tamamlanmadan/)
  })

  test('açılıştan önce biten indirme sayılmaz', async () => {
    const items = [{ state: 'completed', completedAt: 1 }, { state: 'downloading' }]
    const { k, calls } = mk(items)
    k.arm()
    items[1].state = 'paused'
    await k.tick(); await k.tick()
    assert.equal(calls.length, 0)
  })

  test('SINAMA KİPİ: komut değişkeni yoksa hiçbir program çalışmaz, sahte geri sayım ve iptal de çalıştırmaz', async () => {
    const items = [{ state: 'downloading' }]
    const { k, calls } = mk(items, { shutdownCmd: null })
    k.arm()
    items[0].state = 'completed'; items[0].completedAt = Date.now() + 5
    await k.tick(); await k.tick()
    assert.equal(k.durum().countdown, true)
    assert.equal(k.durum().simulated, true)
    await k.disarm()
    assert.equal(calls.length, 0, 'run hiç çağrılmadı')
    k.stop()
  })

  test('komut başarısızsa bilgisayar kapanmadı bildirilir', async () => {
    const items = [{ state: 'downloading' }]
    const { k } = mk(items)
    k.run = async () => ({ code: 5, stderr: 'erişim reddedildi' })
    k.arm(); items[0].state = 'completed'; items[0].completedAt = Date.now() + 5
    await k.tick(); await k.tick()
    const d = k.durum()
    assert.equal(d.countdown, false)
    assert.match(d.message, /kapatılmadı/)
    k.stop()
  })

  test('kaynak denetimi: shutdown.exe yalnız lib/kapat.mjs içinde geçer', () => {
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib')
    for (const f of fs.readdirSync(lib)) {
      const has = /shutdown\.exe/i.test(fs.readFileSync(path.join(lib, f), 'utf8'))
      assert.equal(has, f === 'kapat.mjs', f)
    }
  })
})

describe('Kapatma (servis)', () => {
  const sc = serviceConfig(21, { OFFLINE_KAPAT_KONTROL_MS: '300' })
  const sahte = path.join(TEST_DIR, 'svc21-sahte-kapat.mjs')
  const kayit = path.join(TEST_DIR, 'svc21-kapat-kayit.txt')
  let svc, seed, fx
  before(async () => {
    seed = await startSeeder(); fx = seed.fx
    cleanService(sc)
    fs.mkdirSync(path.dirname(sahte), { recursive: true })
    fs.writeFileSync(sahte, "import fs from 'node:fs'\nfs.appendFileSync(process.env.FAKE_KAYIT, JSON.stringify(process.argv.slice(2)) + '\\n')\n")
    fs.rmSync(kayit, { force: true })
    Object.assign(sc.env, { OFFLINE_KAPATMA_KOMUTU: sahte, FAKE_KAYIT: kayit })
    svc = await startService(sc)
  })
  after(async () => { await svc?.stop(); killAll(); for (const p of [sahte, kayit]) fs.rmSync(p, { force: true }); cleanService(sc) })

  const kayitlar = () => (fs.existsSync(kayit) ? fs.readFileSync(kayit, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])

  test('etkin indirme yokken açılamaz; geçersiz gövde 400; başlangıçta kapalı', async () => {
    assert.equal((await svc.api('GET', '/api/kapat-zamanla')).phase, 'kapali')
    await assert.rejects(svc.api('POST', '/api/kapat-zamanla', { enabled: true }), e => e.status === 409 && /Etkin indirme yok/.test(e.body.err))
    for (const bad of [{}, { enabled: 'true' }, { enabled: 1 }]) await assert.rejects(svc.api('POST', '/api/kapat-zamanla', bad), e => e.status === 400)
    await assert.rejects(svc.api('GET', '/api/kapat'), e => e.status === 404 || e.status === 405) // /api/kapat servisi kapatır, ayrı uç
    assert.equal((await svc.api('GET', '/api/status')).engine.ready, true, 'servis hâlâ ayakta')
  })

  test('indirme bitince sahte komut /s /t 60 ile çalışır, İptal /a çalıştırır', async () => {
    const ih = fx.klip.infoHash
    await svc.api('POST', '/api/items', { infoHash: ih, files: [0], type: 'movie', id: 'tt0000004' })
    const a = await svc.api('POST', '/api/kapat-zamanla', { enabled: true })
    assert.equal(a.armed, true)
    assert.equal(kayitlar().length, 0, 'indirme sürerken komut çalışmaz')
    const d = await waitFor(async () => { const x = await svc.api('GET', '/api/kapat-zamanla'); return x.countdown && x }, { timeout: 60000, what: 'geri sayım başladı' })
    assert.equal((await svc.item(ih)).state, 'completed')
    assert.ok(d.secondsLeft > 50 && d.secondsLeft <= 60)
    assert.equal(d.simulated, false)
    const k = await waitFor(() => { const r = kayitlar(); return r.length >= 1 && r }, { what: 'sahte komut çağrıldı' })
    assert.deepEqual(k[0].slice(0, 3), ['/s', '/t', '60'])
    assert.equal(k[0][3], '/c')
    assert.match(k[0][4], /Stremio Offline/)
    const r = await svc.api('POST', '/api/kapat-zamanla', { enabled: false })
    assert.equal(r.countdown, false)
    assert.deepEqual(kayitlar()[1], ['/a'])
    assert.equal((await svc.api('GET', '/api/kapat-zamanla')).phase, 'kapali')
  })

  test('kalıcı değil: açıkken servis yeniden başlayınca kapalı', async () => {
    const ih = fx.film.infoHash
    await svc.api('POST', '/api/items', { infoHash: ih, files: [0], type: 'movie', id: 'tt0000001' })
    await svc.api('POST', `/api/items/${ih}/limit`, { downloadLimit: 1000000 }) // ~48 sn sürsün
    assert.equal((await svc.api('POST', '/api/kapat-zamanla', { enabled: true })).armed, true)
    await svc.stop()
    svc = await startService(sc)
    assert.equal((await svc.api('GET', '/api/kapat-zamanla')).phase, 'kapali')
    assert.equal(kayitlar().length, 2, 'yeniden başlatma komut çalıştırmadı')
  })

  test('SINAMA KİPİ güvencesi: komut değişkeni yokken tetiklense de hiçbir program çalışmaz', async () => {
    await svc.stop()
    delete sc.env.OFFLINE_KAPATMA_KOMUTU
    fs.rmSync(kayit, { force: true })
    svc = await startService(sc)
    const ih = fx.klip.infoHash
    const st0 = (await svc.item(fx.film.infoHash)).state
    if (st0 === 'paused' || st0 === 'error') await svc.api('POST', `/api/items/${fx.film.infoHash}/resume`)
    await waitFor(async () => (await svc.item(fx.film.infoHash)).state === 'downloading', { what: 'film sürüyor (önceki durum: ' + st0 + ')' })
    assert.equal((await svc.api('POST', '/api/kapat-zamanla', { enabled: true })).armed, true)
    const d = await waitFor(async () => { const x = await svc.api('GET', '/api/kapat-zamanla'); return x.countdown && x }, { timeout: 90000, what: 'sahte geri sayım' })
    assert.equal(d.simulated, true)
    await sleep(1000)
    assert.equal(kayitlar().length, 0, 'hiçbir komut çalışmadı')
    assert.match(fs.readFileSync(path.join(sc.dataDir, 'servis.log'), 'utf8'), /sınama kipi\] indirmeler bitti; kapatma komutu çalıştırılmadı/)
    assert.equal((await svc.api('POST', '/api/kapat-zamanla', { enabled: false })).countdown, false)
    assert.ok(ih)
  })
})
