// Uygulama içi güncelleme: kurulum programını indirme, doğrulama ve başlatma. Gerçek ağa ve gerçek kurulum programına
// HİÇ çıkılmaz: birimde sahte fetch ve sahte çalıştırıcı, serviste yerel sahte sunucu + node ile çalışan sahte "kurulum".
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startService, serviceConfig, cleanService, waitFor, killAll, ROOT, TEST_DIR } from './harness.mjs'
import { Guncelleme, adresUygun } from '../lib/guncelleme.mjs'

describe('uygulama içi güncelleme (birim, sahte fetch)', () => {
  const icerik = Buffer.from('sahte kurulum programı ' + 'x'.repeat(5000))
  const sha = crypto.createHash('sha256').update(icerik).digest('hex')
  const ASSET_URL = 'https://github.com/AcarPlus/stremio-offline/releases/download/v99.0.0/StremioOffline-Kurulum.exe'
  const CDN_URL = 'https://release-assets.githubusercontent.com/abc/StremioOffline-Kurulum.exe?sig=1'
  const surum = (asset = {}) => ({
    tag_name: 'v99.0.0',
    html_url: 'https://github.com/x/y/releases/tag/v99.0.0',
    assets: [{ name: 'StremioOffline-Kurulum.exe', browser_download_url: ASSET_URL, size: icerik.length, digest: 'sha256:' + sha, ...asset }]
  })
  const mk = ({ release = surum(), dosya = icerik, kurulu = true, yonlendir = CDN_URL } = {}) => {
    const calisan = []
    let cikti = 0
    const fetchFn = async url => {
      if (url.includes('api.github.com')) return new Response(JSON.stringify(release), { status: 200 })
      if (url === ASSET_URL && yonlendir) return new Response(null, { status: 302, headers: { location: yonlendir } })
      return new Response(dosya, { status: 200, headers: { 'content-length': String(dosya.length) } })
    }
    const g = new Guncelleme({
      cfg: { root: ROOT, testMode: false, updateRepo: 'AcarPlus/stremio-offline', updateExitMs: 1 },
      settings: { autoUpdateCheck: true },
      fetchFn,
      kuruluMu: () => kurulu,
      calistir: (p, a) => { calisan.push({ p, a, veri: fs.readFileSync(p) }) },
      cikis: () => { cikti++ }
    })
    return { g, calisan, cikis: () => cikti }
  }
  const bitti = async g => {
    await waitFor(() => g.kurulum.asama !== 'indiriliyor', { timeout: 5000, what: 'kurulum adımı' })
    return g.durum()
  }

  test('adresUygun: yalnız https + GitHub sunucuları; kullanıcı adı yok', () => {
    assert.ok(adresUygun(ASSET_URL))
    assert.ok(adresUygun(CDN_URL))
    for (const u of ['http://github.com/a.exe', 'https://evil.example/a.exe', 'https://github.com.evil.example/a', 'https://u:p@github.com/a', 'file:///c:/a.exe', 'bozuk']) {
      assert.ok(!adresUygun(u), u)
    }
    assert.ok(adresUygun('http://127.0.0.1:5/a', true), 'sınamada yerel http')
  })

  test('kurulum programı bulunur; exe kurulumu değilse, özet yoksa, adres ya da ad uymazsa kurulabilir değil', async () => {
    const d = await mk().g.denetle()
    assert.equal(d.kurulabilir, true)
    assert.equal(d.setupSize, icerik.length)
    assert.equal((await mk({ kurulu: false }).g.denetle()).kurulabilir, false)
    assert.equal((await mk({ release: surum({ digest: undefined }) }).g.denetle()).kurulabilir, false)
    assert.equal((await mk({ release: surum({ browser_download_url: 'https://evil.example/StremioOffline-Kurulum.exe' }) }).g.denetle()).kurulabilir, false)
    assert.equal((await mk({ release: surum({ name: 'StremioOffline.zip' }) }).g.denetle()).kurulabilir, false)
  })

  test('kur: GitHub → CDN yönlendirmesiyle indirir, SHA-256 doğrular, /SILENT /UPDATE ile başlatır, servisi kapatır', async () => {
    const { g, calisan, cikis } = mk()
    await g.denetle()
    assert.equal(g.kur().kurulum.asama, 'indiriliyor')
    assert.throws(() => g.kur(), e => e.status === 409, 'ikinci istek reddedilir')
    const d = await bitti(g)
    assert.equal(d.kurulum.asama, 'baslatildi')
    assert.equal(calisan.length, 1)
    assert.deepEqual(calisan[0].a, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPDATE'])
    assert.equal(path.basename(calisan[0].p), 'StremioOffline-Kurulum.exe')
    assert.ok(calisan[0].veri.equals(icerik))
    await waitFor(() => cikis() === 1, { timeout: 2000, what: 'servis kapanışı' })
    fs.rmSync(path.dirname(calisan[0].p), { recursive: true, force: true })
  })

  test('SHA-256 tutmazsa ya da izinsiz adrese yönlenirse kurulmaz; elle kurulum ve özetsiz sürüm 409', async () => {
    const bozuk = mk({ dosya: Buffer.from('başka içerik ' + 'y'.repeat(4990)) })
    await bozuk.g.denetle()
    bozuk.g.kur()
    let d = await bitti(bozuk.g)
    assert.equal(d.kurulum.asama, 'hata')
    assert.match(d.kurulum.hata, /SHA-256|Boyut/)
    assert.equal(bozuk.calisan.length, 0)
    assert.equal(bozuk.cikis(), 0)

    const kotu = mk({ yonlendir: 'https://evil.example/x.exe' })
    await kotu.g.denetle()
    kotu.g.kur()
    d = await bitti(kotu.g)
    assert.equal(d.kurulum.asama, 'hata')
    assert.match(d.kurulum.hata, /İzin verilmeyen/)
    assert.equal(kotu.calisan.length, 0)

    const elle = mk({ kurulu: false })
    await elle.g.denetle()
    assert.throws(() => elle.g.kur(), e => e.status === 409 && /elle/.test(e.message))
    const ozetsiz = mk({ release: surum({ digest: '' }) })
    await ozetsiz.g.denetle()
    assert.throws(() => ozetsiz.g.kur(), e => e.status === 409 && /SHA-256/.test(e.message))
    assert.throws(() => mk().g.kur(), e => e.status === 409, 'denetimden önce yeni sürüm yok')
  })
})

describe('uygulama içi güncelleme (servis, uçtan uca)', () => {
  const sc = serviceConfig(23)
  let fake, svc, port
  const isaret = path.join(TEST_DIR, 'guncelleme-isaret.json')
  // Sahte "kurulum programı": node ile çalışan küçük betik; aldığı argümanları işaret dosyasına yazar
  const betik = Buffer.from(`require('fs').writeFileSync(${JSON.stringify(isaret)}, JSON.stringify(process.argv.slice(2)))\n`)
  const sha = crypto.createHash('sha256').update(betik).digest('hex')
  before(async () => {
    fs.rmSync(isaret, { force: true })
    fake = http.createServer((req, res) => {
      if (req.url.startsWith('/dl/')) { res.writeHead(200, { 'Content-Length': betik.length }); return res.end(betik) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        tag_name: 'v99.0.0',
        html_url: 'https://github.com/x',
        assets: [{ name: 'StremioOffline-Kurulum.exe', browser_download_url: `http://127.0.0.1:${port}/dl/StremioOffline-Kurulum.exe`, size: betik.length, digest: 'sha256:' + sha }]
      }))
    })
    await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
    port = fake.address().port
    cleanService(sc)
    Object.assign(sc.env, {
      OFFLINE_GUNCELLEME_URL: `http://127.0.0.1:${port}/repos/x/y/releases/latest`,
      OFFLINE_GUNCELLEME_ILK_MS: '600000',
      OFFLINE_GUNCELLEME_KURUCU: process.execPath,
      OFFLINE_GUNCELLEME_EXE_KURULUMU: '1'
    })
    svc = await startService(sc)
  })
  after(async () => {
    try { await svc?.stop() } catch {}
    fake.close()
    killAll()
    cleanService(sc)
    fs.rmSync(isaret, { force: true })
  })

  test('Stremio kökeninden kur isteği yasak; GET 405', async () => {
    const r = await fetch(`${svc.base}/api/guncelleme/kur`, { method: 'POST', headers: { Origin: 'https://web.stremio.com' } })
    assert.equal(r.status, 403)
    await assert.rejects(svc.api('GET', '/api/guncelleme/kur'), e => e.status === 405)
  })

  test('kur: indirir, doğrular, kurulum programını /UPDATE ile başlatır ve servis kapanır', async () => {
    const d = await svc.api('POST', '/api/guncelleme/denetle')
    assert.equal(d.kurulabilir, true)
    await svc.api('POST', '/api/guncelleme/kur')
    await waitFor(() => fs.existsSync(isaret), { timeout: 15000, what: 'kurulum programı çalıştı' })
    assert.deepEqual(JSON.parse(fs.readFileSync(isaret, 'utf8')), ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPDATE'])
    await waitFor(async () => { try { await svc.api('GET', '/api/status'); return false } catch { return true } }, { timeout: 15000, what: 'servis kapandı' })
  })
})
