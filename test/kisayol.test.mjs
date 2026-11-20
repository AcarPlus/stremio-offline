// Tek "Stremio" kısayolu: kur.ps1 / kaldir.ps1 / kisayol-onar.ps1 ve servisin kısayol bekçisi (lib/kisayol-bekci.mjs).
// Tümü geçici klasörlerde, WScript.Shell ile oluşturulmuş sahte kısayollar ve sahte Stremio programı (içi boş dosya) ile;
// kaldırma kaydı yerine OFFLINE_STREMIO_KAYIT ile verilen JSON dosyası okunur. Gerçek kısayollara dokunulmaz.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bekciAcikMi, startKisayolBekci } from '../lib/kisayol-bekci.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const win = process.platform === 'win32'
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor (fn, { timeout = 20000, what = 'koşul' } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (await fn()) return; await sleep(200) }
  throw new Error('zaman aşımı: ' + what)
}

const TMP = win ? fs.mkdtempSync(path.join(os.tmpdir(), 'kisayol-')) : ''
const KAYIT = path.join(TMP, 'kayit.json')
// Çocuk süreçlerin ortamı: gerçek Stremio yolu/kaydı ve gerçek veri klasörü asla kullanılmaz.
const ENV = { ...process.env, OFFLINE_STREMIO_KAYIT: KAYIT }
delete ENV.OFFLINE_STREMIO_EXE
delete ENV.OFFLINE_DATA_DIR
delete ENV.OFFLINE_KISAYOL_BEKCI

function psKomut (cmd, env = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', timeout: 60000, env: { ...ENV, ...env } })
  if (r.status !== 0) throw new Error('powershell: ' + r.stdout + r.stderr)
  return r.stdout
}
function mkLnk (yol, o) {
  fs.mkdirSync(path.dirname(yol), { recursive: true })
  fs.rmSync(yol, { force: true }) // Stremio'nun kurulum programı gibi: sıfırdan yeni dosya
  psKomut(`$o = $env:T_JSON | ConvertFrom-Json; $k = (New-Object -ComObject WScript.Shell).CreateShortcut($o.yol)
    $k.TargetPath = $o.TargetPath; if ($o.Arguments) { $k.Arguments = $o.Arguments }; if ($o.WorkingDirectory) { $k.WorkingDirectory = $o.WorkingDirectory }
    if ($o.IconLocation) { $k.IconLocation = $o.IconLocation }; if ($o.Description) { $k.Description = $o.Description }; $k.Save()`,
  { T_JSON: JSON.stringify({ yol, ...o }) })
}
function lnk (yol) {
  return JSON.parse(psKomut(`$k = (New-Object -ComObject WScript.Shell).CreateShortcut($env:T_YOL)
    [ordered]@{ TargetPath = $k.TargetPath; Arguments = $k.Arguments; WorkingDirectory = $k.WorkingDirectory; IconLocation = $k.IconLocation; Description = $k.Description; WindowStyle = $k.WindowStyle } | ConvertTo-Json`, { T_YOL: yol }))
}
const sahteExe = dir => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'stremio-shell-ng.exe'); fs.writeFileSync(f, 'sahte'); return f }
const setKayit = (dir, ver) => fs.writeFileSync(KAYIT, JSON.stringify({ InstallLocation: dir + '\\', DisplayVersion: ver }))
const okuJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))

/** Bir sınama kümesi: geçici Başlangıç / masaüstü / Başlat menüsü / veri klasörleri. */
function kume (ad) {
  const k = path.join(TMP, ad)
  const d = { st: path.join(k, 'baslangic'), ds: path.join(k, 'masaustu'), pm: path.join(k, 'menu'), veri: path.join(k, 'veri') }
  for (const x of [d.st, d.ds, d.pm]) fs.mkdirSync(x, { recursive: true })
  const ps = (file, args, env) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, file), ...args],
    { encoding: 'utf8', timeout: 90000, env: { ...ENV, ...env } })
  const klasorArg = ['-BaslangicKlasoru', d.st, '-MasaustuKlasoru', d.ds, '-BaslatMenusuKlasoru', d.pm, '-VeriKlasoru', d.veri]
  return {
    ...d,
    kurulum: path.join(d.veri, 'kurulum.json'),
    yedek: path.join(d.veri, 'kisayol-yedek.json'),
    log: path.join(d.veri, 'baslatici.log'),
    kur: () => ps('kur.ps1', klasorArg),
    kaldir: () => ps('kaldir.ps1', klasorArg),
    onar: () => ps('kisayol-onar.ps1', ['-VeriKlasoru', d.veri]),
    logText () { try { return fs.readFileSync(this.log, 'utf8') } catch { return '' } }
  }
}
const ok = r => assert.equal(r.status, 0, r.stdout + r.stderr)
const bizimMi = (l, vbs = 'baslat-stremio.vbs') => l.TargetPath.toLowerCase() === WSCRIPT.toLowerCase() && l.Arguments.toLowerCase().includes(path.join(ROOT, vbs).toLowerCase())

after(() => { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }) })

describe('tek "Stremio" kısayolu: kur / onar / kaldır', { skip: !win }, () => {
  const s = win ? kume('ana') : null
  const exe1 = win ? sahteExe(path.join(TMP, 'Programs', 'Stremio')) : ''
  let exe2

  test('kur.ps1: Stremio\'nun kısayolu başlatıcıya çevrilir, masaüstüne oluşturulur, eski "Stremio Offline" silinir, yedek + işaret yazılır', () => {
    setKayit(path.dirname(exe1), '5.0.28')
    mkLnk(path.join(s.pm, 'Stremio.lnk'), { TargetPath: exe1, WorkingDirectory: path.dirname(exe1) })
    mkLnk(path.join(s.ds, 'Stremio Offline.lnk'), { TargetPath: WSCRIPT, Arguments: `//B //Nologo "${path.join(ROOT, 'baslat-stremio.vbs')}" "node.exe"` })
    // başka bir kuruluma ait eski kısayol (önek çakışması): dokunulmamalı
    mkLnk(path.join(s.pm, 'Stremio Offline.lnk'), { TargetPath: WSCRIPT, Arguments: `//B //Nologo "${path.join(ROOT + '-v2', 'baslat-stremio.vbs')}" "node.exe"` })
    const r = s.kur(); ok(r)

    const servis = lnk(path.join(s.st, 'Stremio Offline Servis.lnk'))
    assert.ok(bizimMi(servis, 'baslat-servis.vbs'), JSON.stringify(servis))
    for (const d of [s.pm, s.ds]) {
      const l = lnk(path.join(d, 'Stremio.lnk'))
      assert.ok(bizimMi(l), JSON.stringify(l))
      assert.equal(path.resolve(l.WorkingDirectory), path.resolve(ROOT))
      assert.equal(l.IconLocation.toLowerCase(), (exe1 + ',0').toLowerCase(), 'Stremio simgesi (kaldırma kaydındaki yerden)')
    }
    assert.ok(!fs.existsSync(path.join(s.ds, 'Stremio Offline.lnk')), 'eski kısayol silindi')
    assert.ok(fs.existsSync(path.join(s.pm, 'Stremio Offline.lnk')), 'başka kuruluma ait eski kısayol kaldı')
    assert.ok(!fs.readdirSync(s.ds).some(f => f !== 'Stremio.lnk'), 'masaüstünde tek kısayol')

    const y = okuJson(s.yedek).kisayollar
    const pm = y.find(e => e.yol.toLowerCase() === path.join(s.pm, 'Stremio.lnk').toLowerCase())
    const ds = y.find(e => e.yol.toLowerCase() === path.join(s.ds, 'Stremio.lnk').toLowerCase())
    assert.equal(pm.bizimOlusturdu, false)
    assert.equal(pm.asil.TargetPath.toLowerCase(), exe1.toLowerCase())
    assert.equal(ds.bizimOlusturdu, true)
    const k = okuJson(s.kurulum)
    assert.equal(path.resolve(k.kok), path.resolve(ROOT))
    assert.equal(k.klasorler.masaustu, s.ds)
    assert.ok(k.node && k.kuruldu)

    ok(s.kur()) // yinelenen kurulum güvenli; yedekteki asıl, bizim başlatıcı ile ezilmez
    const y2 = okuJson(s.yedek).kisayollar
    assert.equal(y2.length, 2)
    assert.equal(y2.find(e => !e.bizimOlusturdu).asil.TargetPath.toLowerCase(), exe1.toLowerCase())
  })

  test('kisayol-onar.ps1: güncelleme Stremio kısayolunu yeniden yazınca yine başlatıcıya çevirir; ikinci çalıştırma bir şey yapmaz', () => {
    mkLnk(path.join(s.pm, 'Stremio.lnk'), { TargetPath: exe1, WorkingDirectory: path.dirname(exe1), Description: 'Stremio 5.0.29' })
    setKayit(path.dirname(exe1), '5.0.29')
    ok(s.onar())
    assert.ok(bizimMi(lnk(path.join(s.pm, 'Stremio.lnk'))))
    assert.match(s.logText(), /yonlendirildi/)
    const pm = okuJson(s.yedek).kisayollar.find(e => !e.bizimOlusturdu)
    assert.equal(pm.asil.Description, 'Stremio 5.0.29', 'yedek güncellendi')
    const once = s.logText()
    ok(s.onar())
    assert.equal(s.logText(), once, 'değişiklik yoksa günlüğe yazılmaz')
  })

  test('kisayol-onar.ps1: Stremio\'nun yeri değişince (kaldırma kaydı) simgeler düzeltilir', () => {
    exe2 = sahteExe(path.join(TMP, 'Programs', 'Stremio-yeni'))
    fs.rmSync(exe1)
    setKayit(path.dirname(exe2), '5.1.0')
    ok(s.onar())
    for (const f of [path.join(s.pm, 'Stremio.lnk'), path.join(s.ds, 'Stremio.lnk'), path.join(s.st, 'Stremio Offline Servis.lnk')]) {
      assert.equal(lnk(f).IconLocation.toLowerCase(), (exe2 + ',0').toLowerCase(), f)
    }
    assert.match(s.logText(), /guncellendi/)
  })

  test('kisayol-onar.ps1: silinmiş Başlangıç kısayolunu yeniden oluşturmaz, yalnız bir kez günlüğe yazar', () => {
    fs.rmSync(path.join(s.st, 'Stremio Offline Servis.lnk'))
    ok(s.onar()); ok(s.onar())
    assert.ok(!fs.existsSync(path.join(s.st, 'Stremio Offline Servis.lnk')))
    assert.equal((s.logText().match(/Baslangic kisayolu yok/g) || []).length, 1)
  })

  test('kaldir.ps1 (klasörler kurulum işaretinden): Stremio kısayolu Stremio\'ya döner, bizim oluşturduğumuz silinir, işaret ve yedek silinir', () => {
    assert.ok(fs.existsSync(s.kurulum), 'işaret var (yoksa kaldir.ps1 gerçek klasörlere bakardı; çalıştırılmaz)')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'kaldir.ps1'), '-VeriKlasoru', s.veri], { encoding: 'utf8', timeout: 90000, env: ENV })
    ok(r)
    const l = lnk(path.join(s.pm, 'Stremio.lnk'))
    // asıl hedef (exe1) artık yok: güncel Stremio programına döner
    assert.equal(l.TargetPath.toLowerCase(), exe2.toLowerCase())
    assert.equal(l.Arguments, '')
    assert.ok(!fs.existsSync(path.join(s.ds, 'Stremio.lnk')), 'bizim oluşturduğumuz silindi')
    assert.ok(fs.existsSync(path.join(s.pm, 'Stremio Offline.lnk')), 'başka kuruluma ait kısayol kaldı')
    assert.ok(!fs.existsSync(s.kurulum) && !fs.existsSync(s.yedek))
    ok(s.onar()) // işaret yok: hiçbir şey yapmaz
    assert.equal(lnk(path.join(s.pm, 'Stremio.lnk')).TargetPath.toLowerCase(), exe2.toLowerCase())
  })

  test('kur → kaldır: Stremio kısayolunun tüm alanları asıl haline döner', () => {
    const t = kume('geri')
    const exe = sahteExe(path.join(TMP, 'Programs', 'Stremio-geri'))
    setKayit(path.dirname(exe), '5.0.28')
    mkLnk(path.join(t.pm, 'Stremio.lnk'), { TargetPath: exe, WorkingDirectory: path.dirname(exe), Description: 'asıl açıklama' })
    mkLnk(path.join(t.ds, 'Stremio.lnk'), { TargetPath: exe, Arguments: '--x', WorkingDirectory: path.dirname(exe), IconLocation: exe + ',0' })
    const once = [lnk(path.join(t.pm, 'Stremio.lnk')), lnk(path.join(t.ds, 'Stremio.lnk'))]
    ok(t.kur())
    assert.ok(bizimMi(lnk(path.join(t.ds, 'Stremio.lnk'))))
    ok(t.kaldir())
    assert.deepEqual([lnk(path.join(t.pm, 'Stremio.lnk')), lnk(path.join(t.ds, 'Stremio.lnk'))], once)
    assert.deepEqual(fs.readdirSync(t.st), [], 'servis kısayolu silindi')
  })

  test('başka bir şeye giden "Stremio.lnk" kur/onar/kaldır tarafından değiştirilmez', () => {
    const t = kume('baska')
    const exe = sahteExe(path.join(TMP, 'Programs', 'Stremio-baska'))
    setKayit(path.dirname(exe), '5.0.28')
    const baska = path.join(TMP, 'baska-program.exe'); fs.writeFileSync(baska, 'x')
    mkLnk(path.join(t.ds, 'Stremio.lnk'), { TargetPath: baska })
    const once = lnk(path.join(t.ds, 'Stremio.lnk'))
    const r = t.kur(); ok(r)
    assert.match(r.stdout, /atlandi/)
    assert.deepEqual(lnk(path.join(t.ds, 'Stremio.lnk')), once)
    assert.ok(bizimMi(lnk(path.join(t.pm, 'Stremio.lnk'))), 'Başlat menüsünde Stremio kısayolu yoktu: oluşturuldu')
    ok(t.onar())
    assert.deepEqual(lnk(path.join(t.ds, 'Stremio.lnk')), once)
    ok(t.kaldir())
    assert.deepEqual(lnk(path.join(t.ds, 'Stremio.lnk')), once)
    assert.ok(!fs.existsSync(path.join(t.pm, 'Stremio.lnk')))
  })

  test('kisayol-onar.ps1: kurulum işareti yoksa ya da başka klasöre aitse hiçbir kısayola dokunmaz', () => {
    const t = kume('isaretsiz')
    const exe = sahteExe(path.join(TMP, 'Programs', 'Stremio-isaretsiz'))
    setKayit(path.dirname(exe), '5.0.28')
    mkLnk(path.join(t.pm, 'Stremio.lnk'), { TargetPath: exe })
    const once = lnk(path.join(t.pm, 'Stremio.lnk'))
    ok(t.onar())
    assert.deepEqual(lnk(path.join(t.pm, 'Stremio.lnk')), once)
    fs.mkdirSync(t.veri, { recursive: true })
    fs.writeFileSync(t.kurulum, JSON.stringify({ surum: 1, kok: ROOT + '-baska', node: process.execPath, klasorler: { baslangic: t.st, masaustu: t.ds, baslatMenusu: t.pm } }))
    ok(t.onar())
    assert.deepEqual(lnk(path.join(t.pm, 'Stremio.lnk')), once)
    assert.ok(!fs.existsSync(t.log), 'günlük de yazılmadı')
  })
})

describe('ortak.ps1 Get-StremioExe: Stremio yeri', { skip: !win }, () => {
  const bul = env => psKomut(`. "${path.join(ROOT, 'ortak.ps1')}"; Get-StremioExe`, env).trim()
  test('OFFLINE_STREMIO_EXE > kaldırma kaydındaki InstallLocation > varsayılan yol', () => {
    const k = path.join(os.tmpdir(), 'kayit-' + process.pid + '.json')
    fs.writeFileSync(k, JSON.stringify({ InstallLocation: 'D:\\Uygulamalar\\Stremio\\', DisplayVersion: '5.0.28' }))
    try {
      assert.equal(bul({ OFFLINE_STREMIO_KAYIT: k }), 'D:\\Uygulamalar\\Stremio\\stremio-shell-ng.exe')
      assert.equal(bul({ OFFLINE_STREMIO_KAYIT: k, OFFLINE_STREMIO_EXE: 'E:\\sahte.exe' }), 'E:\\sahte.exe')
      assert.equal(bul({ OFFLINE_STREMIO_KAYIT: k + '.yok' }), path.join(process.env.LOCALAPPDATA, 'Programs', 'Stremio', 'stremio-shell-ng.exe'), 'kayıt yoksa varsayılan')
    } finally { fs.rmSync(k, { force: true }) }
  })
})

describe('kısayol bekçisi (lib/kisayol-bekci.mjs)', { skip: !win }, () => {
  test('sınama kipinde varsayılan kapalı; OFFLINE_KISAYOL_BEKCI ile açılır/kapanır', () => {
    assert.equal(bekciAcikMi({ testMode: true }, {}), false)
    assert.equal(bekciAcikMi({ testMode: true }, { OFFLINE_KISAYOL_BEKCI: '1' }), true)
    assert.equal(bekciAcikMi({ testMode: false }, {}), true)
    assert.equal(bekciAcikMi({ testMode: false }, { OFFLINE_KISAYOL_BEKCI: '0' }), false)
    assert.equal(startKisayolBekci({ testMode: true, root: ROOT, dataDir: TMP }, { env: {} }), null)
  })

  test('kurulum işareti yoksa betik hiç çalıştırılmaz', async () => {
    const veri = fs.mkdtempSync(path.join(os.tmpdir(), 'bekci-bos-'))
    let n = 0
    const dur = startKisayolBekci({ testMode: true, root: ROOT, dataDir: veri }, { env: { ...ENV, OFFLINE_KISAYOL_BEKCI: '1' }, ilkMs: 20, aralikMs: 100, onRun: () => n++ })
    try { await sleep(800); assert.equal(n, 0) } finally { dur(); fs.rmSync(veri, { recursive: true, force: true }) }
  })

  test('Stremio kısayolu yeniden yazılınca (güncelleme) bekçi betiği kendiliğinden çalıştırır ve kısayolu geri çevirir', async () => {
    const t = kume('bekci')
    const exe = sahteExe(path.join(TMP, 'Programs', 'Stremio-bekci'))
    setKayit(path.dirname(exe), '5.0.28')
    mkLnk(path.join(t.pm, 'Stremio.lnk'), { TargetPath: exe })
    ok(t.kur())
    let n = 0
    // 10 dk'lık yoklama bu sınamada devreye girmez: yalnız ilk çalıştırma ve klasör izleme
    const dur = startKisayolBekci({ testMode: true, root: ROOT, dataDir: t.veri }, {
      env: { ...ENV, OFFLINE_KISAYOL_BEKCI: '1' }, ilkMs: 50, aralikMs: 3600000, gecikmeMs: 300, onRun: () => n++
    })
    try {
      await waitFor(() => n >= 1, { what: 'ilk çalıştırma' })
      await sleep(4000) // ilk çalıştırma bitsin (izleyiciler kuruldu)
      const once = n
      mkLnk(path.join(t.pm, 'Stremio.lnk'), { TargetPath: exe, Description: 'güncelleme sonrası' })
      await waitFor(() => n > once, { what: 'değişiklik üzerine çalıştırma' })
      await waitFor(() => bizimMi(lnk(path.join(t.pm, 'Stremio.lnk'))), { timeout: 30000, what: 'kısayol yeniden çevrildi' })
      assert.match(t.logText(), /yonlendirildi/)
    } finally { dur() }
    await sleep(500)
    ok(t.kaldir())
  })
})
