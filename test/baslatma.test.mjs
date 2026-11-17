// Faz 4: ikinci servis örneği sessizce çıkar; kur.ps1 / kaldir.ps1 yalnızca verilen klasörlere .lnk yazar/siler.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startService, serviceConfig, cleanService, killAll, ROOT, RQBIT, waitFor } from './harness.mjs'

describe('ikinci servis örneği', () => {
  const sc = serviceConfig(96)
  let svc
  before(async () => { cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop(); killAll(); cleanService(sc) })

  test('çalışan servisin portunda başlatılan ikinci örnek sessizce çıkar, motora dokunmaz', async () => {
    const pidFile = path.join(sc.dataDir, 'rqbit', 'rqbit.pid')
    assert.ok(fs.existsSync(pidFile), 'birinci örneğin motor pid dosyası var')
    const second = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, ...sc.env }, stdio: 'ignore', windowsHide: true })
    const code = await new Promise(resolve => { second.on('exit', resolve); setTimeout(() => { try { second.kill() } catch {} }, 15000) })
    assert.equal(code, 0, 'çıkış kodu 0 (hata değil)')
    assert.ok(fs.existsSync(pidFile), 'ikinci örnek birinci örneğin pid dosyasını silmedi')
    assert.ok((await svc.api('GET', '/api/status')).engine.ready, 'birinci örnek ve motoru çalışıyor')
  })
})

describe('kur.ps1 / kaldir.ps1', { skip: process.platform !== 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kur-'))
  const dirs = { st: path.join(tmp, 'baslangic'), ds: path.join(tmp, 'masaustu'), pm: path.join(tmp, 'menu') }
  before(() => { for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true }) })
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const ps = (file, args = []) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, file),
    '-BaslangicKlasoru', dirs.st, '-MasaustuKlasoru', dirs.ds, '-BaslatMenusuKlasoru', dirs.pm, ...args], { encoding: 'utf8', timeout: 60000 })
  const lnkInfo = f => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$k=(New-Object -ComObject WScript.Shell).CreateShortcut('${f}'); $k.TargetPath; $k.Arguments; $k.WorkingDirectory`], { encoding: 'utf8' }).stdout.split(/\r?\n/)

  test('kur.ps1 üç kısayol oluşturur (betik yolları kendi konumundan türer), kaldir.ps1 siler', () => {
    const r = ps('kur.ps1')
    assert.equal(r.status, 0, r.stderr || r.stdout)
    const files = { st: 'Stremio Offline Servis.lnk', ds: 'Stremio Offline.lnk', pm: 'Stremio Offline.lnk' }
    for (const [k, f] of Object.entries(files)) {
      const p = path.join(dirs[k], f)
      assert.ok(fs.existsSync(p), p)
      const [target, args, wd] = lnkInfo(p)
      assert.match(target, /wscript\.exe$/i)
      assert.ok(args.includes(path.join(ROOT, k === 'st' ? 'baslat-servis.vbs' : 'baslat-stremio.vbs')), args)
      assert.equal(path.resolve(wd), path.resolve(ROOT))
    }
    assert.equal(ps('kur.ps1').status, 0, 'yinelenen kurulum güvenli')
    const k2 = ps('kaldir.ps1')
    assert.equal(k2.status, 0, k2.stderr || k2.stdout)
    for (const [k, f] of Object.entries(files)) assert.ok(!fs.existsSync(path.join(dirs[k], f)), 'silindi: ' + f)
  })
})

describe('E9: kapı başka bir uygulamada', () => {
  const sc = serviceConfig(98)
  let tutucu
  before(async () => {
    cleanService(sc)
    tutucu = http.createServer((q, r) => r.end('baska uygulama')) // /manifest.json bizim eklentiye benzemez
    await new Promise(resolve => tutucu.listen(sc.port, '127.0.0.1', resolve))
  })
  after(async () => { await new Promise(resolve => tutucu.close(resolve)); killAll(); cleanService(sc) })

  test('servis hata koduyla çıkar, kütüphaneye ve motora dokunmaz, günlük doğruyu söyler', async () => {
    const out = []
    const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, ...sc.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    p.stdout.on('data', d => out.push(String(d))); p.stderr.on('data', d => out.push(String(d)))
    const code = await new Promise(resolve => { p.on('exit', resolve); setTimeout(() => { try { p.kill() } catch {} }, 20000) })
    assert.equal(code, 1)
    assert.ok(!fs.existsSync(path.join(sc.dataDir, 'library.json')), 'library.json oluşturulmadı/yazılmadı')
    assert.ok(!fs.existsSync(path.join(sc.dataDir, 'rqbit', 'rqbit.pid')), 'motor başlatılmadı')
    const metin = out.join('')
    assert.match(metin, /başka bir uygulama/)
    assert.doesNotMatch(metin, /servis zaten çalışıyor/)
  })
})

describe('E1: durdur-servis.ps1', { skip: process.platform !== 'win32' }, () => {
  const sc = serviceConfig(99)
  const env = { ...process.env, ...sc.env, OFFLINE_RQBIT_EXE: RQBIT }
  const durdur = (...args) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'durdur-servis.ps1'), '-Port', String(sc.port), ...args], { encoding: 'utf8', timeout: 90000, env })
  const up = async () => { try { return (await fetch(`http://127.0.0.1:${sc.port}/manifest.json`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }
  const rqbitUp = async () => { try { await fetch(`http://127.0.0.1:${sc.rqbitPort}/`, { signal: AbortSignal.timeout(1000) }); return true } catch { return false } }
  after(() => { durdur(); killAll(); cleanService(sc) })

  test('çalışan servisi temiz durdurur (servis ve rqbit kapanır, pid dosyası kalmaz)', async () => {
    cleanService(sc)
    const svc = await startService(sc)
    assert.ok(await up() && await rqbitUp())
    const r = durdur()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /durduruldu/)
    assert.ok(!(await up()), 'servis kapandı')
    await waitFor(async () => !(await rqbitUp()), { timeout: 10000, what: 'rqbit kapandı' })
    assert.ok(!fs.existsSync(path.join(sc.dataDir, 'rqbit', 'rqbit.pid')), 'pid dosyası temizlendi')
    assert.ok(svc.proc.exitCode !== null || svc.proc.killed || svc.proc.signalCode, 'servis süreci bitti')
  })

  test('kapıyı başka bir uygulama tutuyorsa dokunmaz', async () => {
    const tutucu = http.createServer((q, r) => r.end('{"id":"baska"}'))
    await new Promise(resolve => tutucu.listen(sc.port, '127.0.0.1', resolve))
    try {
      const r = durdur()
      assert.equal(r.status, 1, r.stdout + r.stderr)
      assert.match(r.stdout, /hicbir sey kapatilmadi/)
      assert.ok(tutucu.listening, 'başka uygulama yaşıyor')
    } finally { await new Promise(resolve => tutucu.close(resolve)) }
  })

  test('-Yeniden: durdurur ve gizli yeniden başlatır; servis yokken "çalışmıyor" der', async () => {
    await startService(sc)
    const r = durdur('-Yeniden')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /yeniden baslatildi/)
    assert.ok(await up(), 'yeni servis yanıt veriyor')
    const durum = await (await fetch(`http://127.0.0.1:${sc.port}/api/status`)).json()
    assert.ok(durum.downloadDir, 'API çalışıyor')
    const r2 = durdur()
    assert.equal(r2.status, 0, r2.stdout + r2.stderr)
    assert.ok(!(await up()))
    const r3 = durdur()
    assert.equal(r3.status, 0)
    assert.match(r3.stdout, /calismiyor/)
  })
})
