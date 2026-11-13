// Güvenlik ve girdi denetimi sınamaları (Faz 1 doğrulama kusurları K1, K3, K5, K6).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startService, serviceConfig, cleanService, killAll } from './harness.mjs'

/** Ham istek: Host/Origin başlıklarını ve gövdeyi tam denetlemek için http.request. */
function raw (svc, method, path, { headers = {}, body } = {}) {
  const u = new URL(svc.base)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers: { ...headers } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('güvenlik ve girdi denetimi', () => {
  const sc = serviceConfig(96)
  const HASH = 'd'.repeat(40)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop(); killAll(); cleanService(sc) })

  test('K1: yabancı Host başlığı reddedilir, kendi adları kabul edilir', async () => {
    const port = new URL(svc.base).port
    assert.equal((await raw(svc, 'GET', '/api/status', { headers: { Host: 'evil.example' } })).status, 403)
    assert.equal((await raw(svc, 'GET', '/api/status', { headers: { Host: 'evil.example:' + port } })).status, 403)
    assert.equal((await raw(svc, 'GET', '/api/status', { headers: { Host: '127.0.0.1:1' } })).status, 403)
    assert.equal((await raw(svc, 'GET', '/manifest.json', { headers: { Host: 'evil.example' } })).status, 403)
    for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      assert.equal((await raw(svc, 'GET', '/api/status', { headers: { Host: h } })).status, 200, h)
    }
  })

  test('K1: /play bilinmeyen hash için indirme başlatmaz (köken olsun olmasın)', async () => {
    for (const headers of [{}, { Origin: 'https://evil.example' }, { Origin: 'https://web.stremio.com' }]) {
      const r = await raw(svc, 'GET', `/play/movie/tt0000009/${HASH}/0`, { headers })
      assert.equal(r.status, 404, JSON.stringify(headers))
    }
    const items = await svc.api('GET', '/api/items')
    assert.equal((items.items || items).length, 0, 'öğe oluşmamalı')
  })

  test('K1: yabancı köken yönetim uçlarına erişemez', async () => {
    const r = await raw(svc, 'POST', '/api/items', { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ infoHash: HASH }) })
    assert.equal(r.status, 403)
  })
})
