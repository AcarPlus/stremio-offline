// Ayarlar sayfasının kuralları: kuyruk (aynı anda en çok N), saat aralığı, disk alt sınırı, izlenenleri silme,
// genel ayarların doğrulanması, Türkçe tercihi, klip penceresi. Birim (sahte yönetici) + gerçek serviste kuyruk.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Kurallar, saatIcinde } from '../lib/kurallar.mjs'
import { Settings, GENEL, genelDeger } from '../lib/settings.mjs'
import { isTurkish } from '../lib/torrentio.mjs'
import { clipWindow } from '../lib/klip.mjs'
import { startSeeder, startService, serviceConfig, cleanService, waitFor, killAll } from './harness.mjs'

const at = (hh, mm) => new Date(2026, 10, 20, hh, mm)

describe('saat aralığı', () => {
  test('gün içi, gece yarısını aşan ve bütün gün', () => {
    assert.equal(saatIcinde(at(9, 0), '08:00', '17:00'), true)
    assert.equal(saatIcinde(at(17, 0), '08:00', '17:00'), false, 'bitiş dahil değil')
    assert.equal(saatIcinde(at(2, 30), '01:00', '08:00'), true)
    assert.equal(saatIcinde(at(23, 30), '22:00', '06:00'), true)
    assert.equal(saatIcinde(at(5, 59), '22:00', '06:00'), true)
    assert.equal(saatIcinde(at(12, 0), '22:00', '06:00'), false)
    assert.equal(saatIcinde(at(12, 0), '03:00', '03:00'), true, 'başlangıç = bitiş: bütün gün')
  })
})

describe('genel ayarlar', () => {
  test('doğrulama', () => {
    assert.equal(genelDeger('maxConcurrent', 3), 3)
    assert.equal(genelDeger('maxConcurrent', 21), null)
    assert.equal(genelDeger('maxConcurrent', 1.5), null)
    assert.equal(genelDeger('scheduleStart', '23:59'), '23:59')
    assert.equal(genelDeger('scheduleStart', '24:00'), null)
    assert.equal(genelDeger('scheduleStart', '1:00'), null)
    assert.equal(genelDeger('clipSeconds', 90), 90)
    assert.equal(genelDeger('clipSeconds', 45), null)
    assert.equal(genelDeger('autoQuality', '720p'), '720p')
    assert.equal(genelDeger('autoQuality', '360p'), null)
    assert.equal(genelDeger('notifyOnComplete', 'true'), null)
    assert.equal(genelDeger('yok', 1), null)
  })

  test('kalıcı, geçersiz alan varsa hiçbiri uygulanmaz, bozuk kayıtlı değer varsayılana döner', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-ayar-'))
    try {
      const cfg = { dataDir: dir, downloadDir: dir, autoQuality: '720p', autoMaxSizeGB: 8 }
      const s = new Settings(cfg)
      assert.equal(s.genel().autoQuality, '720p', 'ilk değer config.json’dan')
      assert.equal(s.genel().autoMaxSizeGB, 8)
      assert.equal(s.genel().showBadges, true)
      assert.throws(() => s.set({ maxConcurrent: 2, scheduleEnd: 'öğlen' }), e => e.status === 400)
      assert.equal(s.genel().maxConcurrent, 0, 'hiçbiri uygulanmadı')
      assert.deepEqual(s.set({ maxConcurrent: 2, preferTurkish: true }).sort(), ['maxConcurrent', 'preferTurkish'])
      const kayit = JSON.parse(fs.readFileSync(path.join(dir, 'ayarlar.json'), 'utf8'))
      assert.equal(kayit.maxConcurrent, 2)
      kayit.clipSeconds = 999
      fs.writeFileSync(path.join(dir, 'ayarlar.json'), JSON.stringify(kayit))
      const s2 = new Settings(cfg)
      assert.equal(s2.genel().maxConcurrent, 2)
      assert.equal(s2.genel().preferTurkish, true)
      assert.equal(s2.genel().clipSeconds, GENEL.clipSeconds.def, 'geçersiz kayıt varsayılana döner')
      assert.ok('maxConcurrent' in s2.all() && 'downloadDir' in s2.all())
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('Türkçe tercihi ve klip penceresi', () => {
  test('isTurkish', () => {
    assert.equal(isTurkish({ languages: ['gb', 'tr'] }), true)
    assert.equal(isTurkish({ name: 'Film.2020.1080p.TR.Dublaj.mkv' }), true)
    assert.equal(isTurkish({ name: 'Film 2020 Turkish 720p' }), true)
    assert.equal(isTurkish({ name: 'Film [Türkçe Altyazılı]' }), true)
    assert.equal(isTurkish({ name: 'TRON.Legacy.2010.1080p' }), false, 'TRON Türkçe sayılmaz')
    assert.equal(isTurkish({ name: 'Film.2020.1080p.WEB', languages: ['gb'] }), false)
  })
  test('clipWindow ayarlarla', () => {
    assert.deepEqual(clipWindow(7200), { start: 2160, length: 60 })
    assert.deepEqual(clipWindow(7200, { sec: 90, startPct: 50 }), { start: 3600, length: 90 })
    assert.deepEqual(clipWindow(100, { sec: 30, startPct: 90 }), { start: 90, length: 10 })
    assert.deepEqual(clipWindow(null, { sec: 30 }), { start: 0, length: 30 })
  })
})

// ---------------------------------------------------------------- sahte yönetici ile kurallar
function sahte ({ g = {}, items = [], playing = [] } = {}) {
  const genel = { ...Object.fromEntries(Object.entries(GENEL).map(([k, t]) => [k, typeof t.def === 'function' ? t.def({}) : t.def])), ...g }
  const lib = new Map(items.map(i => [i.infoHash, { autoPaused: null, elleSurdur: false, priority: false, ...i }]))
  const olay = []
  let now = at(12, 0).getTime()
  const M = {
    lib: { all: () => [...lib.values()], get: ih => lib.get(ih), save () {}, saveNow () {} },
    now: () => now,
    isPlaying: i => playing.includes(i.infoHash),
    async pause (ih, { auto = null } = {}) { const i = lib.get(ih); olay.push('pause:' + ih + ':' + auto); if (i.state === 'paused') { if (auto && i.autoPaused) i.autoPaused = auto; return i } i.state = 'paused'; i.autoPaused = auto; return i },
    async resume (ih, { auto = false } = {}) { const i = lib.get(ih); olay.push('resume:' + ih); i.autoPaused = null; i.state = 'downloading'; return i },
    async remove (ih) { olay.push('remove:' + ih); lib.delete(ih); return true }
  }
  const settings = { genel: () => ({ ...genel }) }
  const k = new Kurallar({ cfg: { testMode: true, dataDir: os.tmpdir(), downloadDir: os.tmpdir() }, manager: M, settings, env: {} })
  return { k, M, lib, olay, genel, setNow: d => { now = d.getTime() } }
}
const it = (ih, state, extra = {}) => ({ infoHash: ih, state, addedAt: Number(ih.slice(1)), ...extra })

describe('kurallar (sahte yönetici)', () => {
  test('kuyruk: fazlası en yeniden başlayarak sıraya girer, öncelikli ve elle sürdürülen korunur', async () => {
    const { k, lib } = sahte({ g: { maxConcurrent: 2 }, items: [it('a1', 'downloading'), it('a2', 'downloading', { priority: true }), it('a3', 'downloading'), it('a4', 'resolving', { elleSurdur: true })] })
    await k.tick()
    assert.equal(lib.get('a2').state, 'downloading', 'öncelikli')
    assert.equal(lib.get('a4').state, 'resolving', 'elle sürdürülen')
    assert.equal(lib.get('a3').state, 'paused'); assert.equal(lib.get('a3').autoPaused, 'kuyruk')
    assert.equal(lib.get('a1').state, 'paused'); assert.equal(lib.get('a1').autoPaused, 'kuyruk')
  })

  test('kuyruk: yer açılınca en eski bekleyen başlar; kullanıcının duraklattığına dokunulmaz', async () => {
    const { k, lib, olay } = sahte({ g: { maxConcurrent: 1 }, items: [it('b1', 'completed'), it('b2', 'paused', { autoPaused: 'kuyruk' }), it('b3', 'paused', { autoPaused: 'kuyruk' }), it('b0', 'paused')] })
    await k.tick()
    assert.deepEqual(olay, ['resume:b2'])
    assert.equal(lib.get('b3').state, 'paused')
    assert.equal(lib.get('b0').autoPaused, null)
  })

  test('gate: sınır dolu, saat dışı, disk dolu', () => {
    const { k, lib, setNow } = sahte({ g: { maxConcurrent: 1, scheduleOn: true, scheduleStart: '01:00', scheduleEnd: '08:00' }, items: [it('c1', 'downloading')] })
    setNow(at(3, 0))
    assert.equal(k.gate({ infoHash: 'yeni' }), 'kuyruk')
    assert.equal(k.gate(lib.get('c1')), null, 'kendisi sayılmaz')
    setNow(at(12, 0))
    assert.equal(k.gate({ infoHash: 'yeni' }), 'saat')
    k.diskDusuk = true
    assert.equal(k.gate({ infoHash: 'yeni' }), 'disk')
  })

  test('saat: dışarıda durur (oynatılan ve elle sürdürülen hariç), içeride sürer', async () => {
    const f = sahte({ g: { scheduleOn: true, scheduleStart: '01:00', scheduleEnd: '08:00' }, playing: ['d2'], items: [it('d1', 'downloading'), it('d2', 'downloading'), it('d3', 'downloading', { elleSurdur: true })] })
    await f.k.tick()
    assert.equal(f.lib.get('d1').autoPaused, 'saat')
    assert.equal(f.lib.get('d2').state, 'downloading')
    assert.equal(f.lib.get('d3').state, 'downloading')
    f.setNow(at(2, 0))
    await f.k.tick()
    assert.equal(f.lib.get('d1').state, 'downloading')
  })

  test('saat dışındayken kuyrukta bekleyen "saat" nedenine geçer', async () => {
    const f = sahte({ g: { scheduleOn: true, scheduleStart: '01:00', scheduleEnd: '08:00', maxConcurrent: 1 }, items: [it('e1', 'paused', { autoPaused: 'kuyruk' })] })
    await f.k.tick()
    assert.equal(f.lib.get('e1').autoPaused, 'saat')
    assert.equal(f.lib.get('e1').state, 'paused')
  })

  test('disk: dolunca oynatılmayan her indirme durur, +1 GiB açılınca sürer', async () => {
    const f = sahte({ g: { minFreeGB: 10 }, playing: ['g2'], items: [it('g1', 'downloading', { elleSurdur: true }), it('g2', 'downloading')] })
    let bos = 5 * 2 ** 30
    f.k.olcDisk = async function (g) { this.diskFree = bos; const min = g.minFreeGB * 2 ** 30; if (bos < min) this.diskDusuk = true; else if (this.diskDusuk && bos >= min + 2 ** 30) this.diskDusuk = false }
    await f.k.tick()
    assert.equal(f.lib.get('g1').autoPaused, 'disk', 'elle sürdürülen de durur')
    assert.equal(f.lib.get('g2').state, 'downloading', 'oynatılan durmaz')
    bos = 10.5 * 2 ** 30
    await f.k.tick()
    assert.equal(f.lib.get('g1').state, 'paused', 'pay yetmedi')
    bos = 12 * 2 ** 30
    await f.k.tick()
    assert.equal(f.lib.get('g1').state, 'downloading')
  })

  test('olcDisk gerçek statfs ile: sınır kapalıyken disk hiç dolu sayılmaz', async () => {
    const f = sahte({ g: { minFreeGB: 0 } })
    await f.k.olcDisk({ minFreeGB: 0 })
    assert.equal(f.k.diskDusuk, false)
    await f.k.olcDisk({ minFreeGB: 100000 })
    assert.equal(f.k.diskDusuk, true, '100 TB boş yer yok')
  })

  test('izlenenleri sil: yalnız son oynatmasından X gün geçmiş, bitmiş ve oynatılmayanlar', async () => {
    const gun = 864e5
    const now = at(12, 0).getTime()
    const f = sahte({ g: { deleteWatchedDays: 7 }, playing: ['h4'], items: [
      it('h1', 'completed', { lastPlayedAt: now - 8 * gun }),
      it('h2', 'completed', { lastPlayedAt: now - 2 * gun }),
      it('h3', 'completed'),
      it('h4', 'completed', { lastPlayedAt: now - 30 * gun }),
      it('h5', 'downloading', { lastPlayedAt: now - 30 * gun })
    ] })
    await f.k.tick()
    assert.deepEqual(f.olay.filter(x => x.startsWith('remove')), ['remove:h1'])
  })

  test('sınama kipinde otomatik başlatma ve klasör açma kapalı', async () => {
    const f = sahte()
    assert.deepEqual(f.k.otoBaslat(), { available: false, enabled: false, path: null })
    await assert.rejects(f.k.otoBaslatAyarla(true), e => e.status === 503)
    await assert.rejects(f.k.gunlukAc(), e => e.status === 503)
  })

  test('otomatik başlatma: kısayol yazıcı ile aç/kapat', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-baslangic-'))
    const yazici = path.join(dir, 'yaz.mjs')
    fs.writeFileSync(yazici, "import fs from 'node:fs'; fs.writeFileSync(process.env.SO_LNK, process.env.SO_ARG)")
    try {
      const f = sahte()
      f.k.startupDir = dir
      f.k.env = { OFFLINE_KISAYOL_YAZICI: yazici }
      f.k.cfg.root = 'C:\\kok'
      const o = await f.k.otoBaslatAyarla(true)
      assert.equal(o.enabled, true)
      assert.match(fs.readFileSync(o.path, 'utf8'), /^\/\/B \/\/Nologo ".*baslat-servis\.vbs" ".*"$/)
      assert.equal((await f.k.otoBaslatAyarla(false)).enabled, false)
      assert.equal(fs.existsSync(o.path), false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('bildirim: açıkken komut çalışır, kapalıyken çalışmaz', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-bildirim-'))
    const komut = path.join(dir, 'bildir.mjs')
    const cikti = path.join(dir, 'cikti.txt')
    fs.writeFileSync(komut, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(cikti)}, process.env.SO_BASLIK + '|' + process.env.SO_METIN + '\\n')`)
    try {
      const f = sahte({ g: { notifyOnComplete: true } })
      f.k.env = { OFFLINE_BILDIRIM_KOMUTU: komut }
      f.k.bildir({ displayName: 'Test Film' })
      await waitFor(() => fs.existsSync(cikti), { timeout: 10000, what: 'bildirim' })
      assert.match(fs.readFileSync(cikti, 'utf8'), /İndirme bitti\|Test Film/)
      const f2 = sahte({ g: { notifyOnComplete: false } })
      f2.k.env = { OFFLINE_BILDIRIM_KOMUTU: komut }
      fs.rmSync(cikti)
      f2.k.bildir({ displayName: 'X' })
      await new Promise(r => setTimeout(r, 800))
      assert.equal(fs.existsSync(cikti), false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------- gerçek serviste kuyruk
describe('kuyruk (gerçek servis, yerel döngü)', () => {
  let seed, fx, svc
  const sc = serviceConfig(46, { OFFLINE_KURAL_MS: '300' })
  before(async () => { seed = await startSeeder(); fx = seed.fx; cleanService(sc); svc = await startService(sc) })
  after(async () => { await svc?.stop(); cleanService(sc); killAll() })

  test('aynı anda 1: ikinci indirme "Sırada" bekler, ilki bitince kendiliğinden başlar; elle sürdürme beklemez', async () => {
    await svc.api('POST', '/api/settings', { maxConcurrent: 1 })
    await svc.api('POST', '/api/items', { infoHash: fx.klip.infoHash, files: [0], type: 'movie', id: 'tt0000004' })
    const r2 = await svc.api('POST', '/api/items', { infoHash: fx.film.infoHash, files: [0], type: 'movie', id: 'tt0000001' })
    assert.equal(r2.item.state, 'paused')
    assert.equal(r2.item.autoPaused, 'kuyruk')
    await waitFor(async () => (await svc.item(fx.klip.infoHash)).state === 'completed', { timeout: 60000, what: 'ilki bitti' })
    await waitFor(async () => { const v = await svc.item(fx.film.infoHash); return v.state === 'downloading' }, { timeout: 15000, what: 'sıradaki başladı' })
    // Kullanıcı duraklatınca kural bir daha sürdürmez
    await svc.api('POST', `/api/items/${fx.film.infoHash}/pause`)
    await new Promise(r => setTimeout(r, 1200))
    const v = await svc.item(fx.film.infoHash)
    assert.equal(v.state, 'paused')
    assert.equal(v.autoPaused, null)
  })
})
