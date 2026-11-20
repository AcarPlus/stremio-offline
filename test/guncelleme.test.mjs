// Güncelleme denetimi: sürüm karşılaştırma, GitHub yanıtı, sessiz hata durumları, otomatik denetim ve ayar.
// Gerçek ağa çıkılmaz: adres OFFLINE_GUNCELLEME_URL ile yerel sahte sunucuya yönlendirilir.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startService, serviceConfig, cleanService, waitFor, sleep, killAll, ROOT } from './harness.mjs'
import { parseSurum, karsilastir, Guncelleme } from '../lib/guncelleme.mjs'

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

describe('sürüm karşılaştırma (birim)', () => {
  test('parseSurum ve karsilastir', () => {
    assert.deepEqual(parseSurum('v1.2.3'), [1, 2, 3])
    assert.deepEqual(parseSurum('1.2'), [1, 2, 0])
    assert.deepEqual(parseSurum('V2.0.0-beta.1'), [2, 0, 0])
    assert.equal(parseSurum('sürüm'), null)
    assert.equal(parseSurum(''), null)
    assert.equal(karsilastir('v1.10.0', '1.9.9'), 1)
    assert.equal(karsilastir('v1.0.0', '1.0.0'), 0)
    assert.equal(karsilastir('0.9.9', '1.0.0'), -1)
    assert.equal(karsilastir('v2', '1.99.99'), 1)
    assert.equal(karsilastir('abc', '1.0.0'), 0)
  })
})

describe('Guncelleme (birim, sahte fetch)', () => {
  const mk = (resp, over = {}) => {
    const calls = []
    const fetchFn = async (url, opts) => { calls.push({ url, opts }); if (resp instanceof Error) throw resp; return resp }
    const g = new Guncelleme({ cfg: { root: ROOT, testMode: false, updateRepo: 'AcarPlus/stremio-offline', ...over }, settings: { autoUpdateCheck: true }, fetchFn })
    return { g, calls }
  }
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status })

  test('sürüm package.json\'dan; adres releases/latest; User-Agent stremio-offline, zaman aşımı sinyali var', async () => {
    const { g, calls } = mk(json({ tag_name: 'v' + pkg, html_url: 'https://github.com/x/y/releases/tag/v' + pkg }))
    assert.equal(g.durum().current, pkg)
    await g.denetle()
    assert.equal(calls[0].url, 'https://api.github.com/repos/AcarPlus/stremio-offline/releases/latest')
    assert.equal(calls[0].opts.headers['User-Agent'], 'stremio-offline')
    assert.ok(calls[0].opts.signal)
    assert.equal(g.durum().status, 'guncel')
    assert.equal(g.durum().available, false)
  })

  test('daha yeni etiket: yeni, bağlantı yalnız https', async () => {
    const { g } = mk(json({ tag_name: 'v99.1.0', html_url: 'https://github.com/x/y/releases/tag/v99.1.0' }))
    const d = await g.denetle()
    assert.equal(d.status, 'yeni'); assert.equal(d.available, true); assert.equal(d.latest, '99.1.0'); assert.equal(d.tag, 'v99.1.0')
    assert.equal(d.url, 'https://github.com/x/y/releases/tag/v99.1.0')
    const k = mk(json({ tag_name: 'v99.1.0', html_url: 'javascript:alert(1)' }))
    assert.equal((await k.g.denetle()).url, null)
  })

  test('404 = sürüm yok (sessiz); ağ hatası, 500, bozuk JSON, geçersiz etiket = denetlenemedi', async () => {
    assert.equal((await mk(json({ message: 'Not Found' }, 404)).g.denetle()).status, 'surum-yok')
    assert.equal((await mk(new TypeError('fetch failed')).g.denetle()).status, 'denetlenemedi')
    assert.equal((await mk(json({}, 500)).g.denetle()).status, 'denetlenemedi')
    assert.equal((await mk(new Response('<html>', { status: 200 })).g.denetle()).status, 'denetlenemedi')
    assert.equal((await mk(json({ tag_name: 'nightly' })).g.denetle()).status, 'denetlenemedi')
  })

  test('sınama kipinde sahte adres yoksa ağa HİÇ çıkılmaz', async () => {
    const { g, calls } = mk(json({ tag_name: 'v99.0.0' }), { testMode: true })
    const d = await g.denetle()
    assert.equal(calls.length, 0)
    assert.equal(d.status, 'denetlenemedi')
    g.start() // zamanlayıcı da kurulmaz
    assert.equal(g.timers.length, 0)
  })
})

describe('güncelleme (servis)', () => {
  let fake, port, hits, yanit
  const sc = serviceConfig(22)
  let svc
  const set = (status, body) => { yanit = { status, body } }
  before(async () => {
    hits = []
    set(404, { message: 'Not Found' })
    fake = http.createServer((req, res) => {
      hits.push({ url: req.url, ua: req.headers['user-agent'] })
      res.writeHead(yanit.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(yanit.body))
    })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    port = fake.address().port
    cleanService(sc)
    Object.assign(sc.env, { OFFLINE_GUNCELLEME_URL: `http://127.0.0.1:${port}/repos/x/y/releases/latest`, OFFLINE_GUNCELLEME_ILK_MS: '700', OFFLINE_GUNCELLEME_ARALIK_MS: '600000' })
    svc = await startService(sc)
  })
  after(async () => { await svc?.stop(); fake.close(); killAll(); cleanService(sc) })

  test('otomatik denetim ~ilk gecikmeden sonra kendiliğinden çalışır (sahte sunucuya, User-Agent stremio-offline)', async () => {
    await waitFor(() => hits.length >= 1, { what: 'otomatik denetim' })
    assert.equal(hits[0].ua, 'stremio-offline')
    const g = await svc.api('GET', '/api/guncelleme')
    assert.equal(g.status, 'surum-yok')
    assert.equal(g.current, pkg)
    assert.equal(g.autoUpdateCheck, true)
    assert.equal(g.available, false)
  })

  test('yeni sürüm: POST /denetle; aynı/eski sürüm: güncel', async () => {
    set(200, { tag_name: 'v99.0.0', html_url: 'https://github.com/AcarPlus/stremio-offline/releases/tag/v99.0.0' })
    const g = await svc.api('POST', '/api/guncelleme/denetle')
    assert.equal(g.status, 'yeni'); assert.equal(g.available, true); assert.equal(g.tag, 'v99.0.0')
    assert.match(g.url, /^https:\/\//)
    assert.deepEqual(await svc.api('GET', '/api/guncelleme'), g)
    set(200, { tag_name: 'v' + pkg, html_url: 'https://github.com/x' })
    assert.equal((await svc.api('POST', '/api/guncelleme/denetle')).status, 'guncel')
    set(500, {})
    const e = await svc.api('POST', '/api/guncelleme/denetle')
    assert.equal(e.status, 'denetlenemedi')
    assert.equal((await svc.api('GET', '/api/status')).engine.ready, true)
    await assert.rejects(svc.api('GET', '/api/guncelleme/denetle'), e2 => e2.status === 405)
  })

  test('ayar kapalıyken otomatik denetim yapılmaz; ayar kalıcı; doğrulama', async () => {
    for (const bad of ['false', 0, null]) await assert.rejects(svc.api('POST', '/api/settings', { autoUpdateCheck: bad }), e => e.status === 400)
    assert.equal((await svc.api('POST', '/api/settings', { autoUpdateCheck: false })).autoUpdateCheck, false)
    await svc.stop()
    hits.length = 0
    svc = await startService(sc)
    assert.equal((await svc.api('GET', '/api/guncelleme')).autoUpdateCheck, false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(sc.dataDir, 'ayarlar.json'), 'utf8')).autoUpdateCheck, false)
    await sleep(2000)
    assert.equal(hits.length, 0, 'otomatik denetim kapalı')
    // Elle denetim yine çalışır
    set(200, { tag_name: 'v99.0.0', html_url: 'https://github.com/x' })
    assert.equal((await svc.api('POST', '/api/guncelleme/denetle')).status, 'yeni')
    assert.equal(hits.length, 1)
  })
})
