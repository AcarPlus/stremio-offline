// Faz 4: ikinci servis örneği sessizce çıkar; kur.ps1 / kaldir.ps1 yalnızca verilen klasörlere .lnk yazar/siler.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startService, serviceConfig, cleanService, killAll, ROOT } from './harness.mjs'

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
