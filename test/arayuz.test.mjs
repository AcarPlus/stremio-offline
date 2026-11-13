// Faz 2: İndirme Merkezi sayfasının sunumu ve yeni uçların girdi denetimi (internetsiz).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startService, serviceConfig, cleanService, killAll } from './harness.mjs'

describe('İndirme Merkezi (web/)', () => {
  const sc = serviceConfig(95)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop(); killAll(); cleanService(sc) })

  const get = async p => { const r = await fetch(svc.base + p); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() } }

  test('kök sayfa ve varlıklar sunulur', async () => {
    const root = await get('/')
    assert.equal(root.status, 200)
    assert.match(root.type, /text\/html/)
    assert.ok(root.text.includes('İndirme Merkezi') && root.text.includes('/ui/app.js'))
    const js = await get('/ui/app.js')
    assert.equal(js.status, 200)
    assert.match(js.type, /javascript/)
    assert.ok(js.text.includes("source: 'offline-indir'"))
    const css = await get('/ui/stil.css')
    assert.equal(css.status, 200)
    assert.match(css.type, /text\/css/)
  })

  test('varlık ucu yol gezmeye ve bilinmeyen dosyaya kapalı', async () => {
    for (const p of ['/ui/nope.js', '/ui/.gizli', '/ui/..%2Fserver.mjs', '/ui/..%5Cserver.mjs', '/ui/package.json', '/panel.html']) {
      assert.equal((await get(p)).status, 404, p)
    }
  })

  test('arama ve başlık uçları geçersiz girdiyi reddeder', async () => {
    assert.equal((await get('/api/search?q=a')).status, 400)
    assert.equal((await get('/api/search')).status, 400)
    assert.equal((await get('/api/title?type=x&id=tt1')).status, 400)
    assert.equal((await get('/api/title?type=movie&id=abc')).status, 400)
  })
})
