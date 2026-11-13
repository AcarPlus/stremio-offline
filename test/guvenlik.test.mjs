// Güvenlik ve girdi denetimi sınamaları (Faz 1 doğrulama kusurları K1, K3, K5, K6).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startService, serviceConfig, cleanService, killAll, RQBIT, rqbitArgs, TEST_DIR, sleep, waitFor } from './harness.mjs'
import { Engine } from '../lib/engine.mjs'

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

describe('K5/K6: gövde denetimi', () => {
  const sc = serviceConfig(97)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop(); killAll(); cleanService(sc) })

  test('K5: 3 MB gövde 413 yanıtı alır (bağlantı kopmaz)', async () => {
    const r = await raw(svc, 'POST', '/api/items', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(3e6) }) })
    assert.equal(r.status, 413)
    assert.match(r.text, /çok büyük/)
    assert.equal((await svc.api('GET', '/api/status')).engine !== undefined, true, 'servis yanıt vermeye devam eder')
  })

  test('K6: null / sayı / dizge gövde 400, iç hata metni sızmaz', async () => {
    for (const body of ['null', '5', '"x"', '{bozuk']) {
      const r = await raw(svc, 'POST', '/api/items', { headers: { 'Content-Type': 'application/json' }, body })
      assert.equal(r.status, 400, body)
      assert.ok(!/Cannot read/.test(r.text), body)
    }
  })
})

describe('K8: killStale yalnızca kendi rqbit sürecini kapatır', () => {
  const dir = path.join(TEST_DIR, 'k8')
  const mk = apiPort => ({ rqbitDir: dir, rqbitApiPort: apiPort, rqbitExe: RQBIT, downloadDir: dir })
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  after(() => { killAll(); fs.rmSync(dir, { recursive: true, force: true }) })

  test('başka kapıda çalışan rqbit.exe dokunulmadan kalır, bizimki kapanır', async () => {
    fs.mkdirSync(dir, { recursive: true })
    const other = spawn(RQBIT, rqbitArgs({ api: 11781, port: 11782, out: path.join(dir, 'o') }), { stdio: 'ignore', windowsHide: true })
    const ours = spawn(RQBIT, rqbitArgs({ api: 11783, port: 11784, out: path.join(dir, 'b') }), { stdio: 'ignore', windowsHide: true })
    try {
      await sleep(1500)
      // pid dosyası başkasının rqbit'ini gösteriyor, bizim API kapımız 11783
      const eng = new Engine(mk(11783))
      fs.writeFileSync(eng.pidFile, String(other.pid))
      eng.killStale()
      await sleep(500)
      assert.ok(alive(other.pid), 'başka rqbit öldürülmemeli')
      assert.ok(!fs.existsSync(eng.pidFile))
      // kendi sürecimiz
      fs.writeFileSync(eng.pidFile, String(ours.pid))
      eng.killStale()
      await waitFor(() => !alive(ours.pid), { timeout: 5000, what: 'kendi rqbit kapandı' })
      assert.ok(alive(other.pid))
    } finally { other.kill(); ours.kill() }
  })
})
