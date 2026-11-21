// İndirme klasörü seçimi: doğrulama, klasör seçici ucu (sahte program), yalnız yeni indirmelere uygulanma,
// süren/biten indirmelerin eski yerinde kalması, kalıcılık. Gerçek klasör seçme penceresi ASLA açılmaz.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startSeeder, startService, serviceConfig, cleanService, waitFor, readRange, killAll, TEST_DIR, MiB } from './harness.mjs'
import { FILM, KLIP, sourcePath, readSource } from './fixture.mjs'
import { denetleKlasor, klasorSec, korumaIpucu, yazmaEngeliMi } from '../lib/klasor.mjs'

describe('denetleKlasor (birim)', () => {
  const kok = path.join(TEST_DIR, 'klasor-birim')
  before(() => { fs.rmSync(kok, { recursive: true, force: true }); fs.mkdirSync(kok, { recursive: true }) })
  after(() => fs.rmSync(kok, { recursive: true, force: true }))

  test('boş, sayı, göreli ve geçersiz yollar anlaşılır Türkçe hatayla reddedilir', () => {
    for (const bad of [undefined, null, 5, '', '   ', 'filmler', '.\\filmler', '..\\x', 'C:filmler', '\\filmler', 'a\0b', 'x'.repeat(500)]) {
      assert.throws(() => denetleKlasor(bad), e => e.status === 400 && /klasör|yol/i.test(e.message), JSON.stringify(bad))
    }
  })

  test('olmayan klasör oluşturulur, deneme dosyası bırakılmaz', () => {
    const yeni = path.join(kok, 'a', 'b', 'c')
    assert.equal(denetleKlasor(yeni), yeni)
    assert.ok(fs.statSync(yeni).isDirectory())
    assert.deepEqual(fs.readdirSync(yeni), [])
    assert.equal(denetleKlasor('"' + yeni + path.sep + '"'), yeni, 'tırnaklı ve sonu ayraçlı yol normalleşir')
  })

  test('dosya olan yol ve oluşturulamayan yol reddedilir', () => {
    const dosya = path.join(kok, 'dosya.txt')
    fs.writeFileSync(dosya, 'x')
    assert.throws(() => denetleKlasor(dosya), e => e.status === 400 && /oluşturulamadı|klasör değil/.test(e.message))
    assert.throws(() => denetleKlasor(path.join(dosya, 'alt')), e => e.status === 400)
  })

  test('Denetimli klasör erişimi engeli tanınır ve izin verilecek programlar adıyla söylenir', { skip: process.platform !== 'win32' }, () => {
    for (const k of ['ENOENT', 'EPERM', 'EACCES', 'error adding torrent: Sistem belirtilen dosyayı bulamıyor. (os error 2)', 'x (os error 5)']) assert.ok(yazmaEngeliMi(k), k)
    for (const k of ['', 'ENOSPC', 'rqbit zaman aşımı: POST /torrents', '(os error 22)', '(os error 123)']) assert.ok(!yazmaEngeliMi(k), k)
    const ip = korumaIpucu(['C:\\x\\rqbit.exe', 'C:\\x\\rqbit.exe'])
    assert.match(ip, /Denetimli klasör erişimi/)
    assert.ok(ip.includes(process.execPath) && ip.includes('C:\\x\\rqbit.exe'))
    assert.equal(ip.split('rqbit.exe').length, 2, 'aynı program bir kez yazılır')
  })

  test('sınama kipinde program verilmediyse seçici pencere açılmaz (503)', async () => {
    await assert.rejects(klasorSec({ testMode: true, folderPicker: null }, ''), e => e.status === 503)
  })
})

describe('indirme klasörü (servis)', () => {
  const sc = serviceConfig(20)
  const dirA = sc.downloadDir
  const dirB = path.join(TEST_DIR, 'svc20', 'yeni-klasor', 'ikinci')
  const secim = path.join(TEST_DIR, 'svc20-secim.txt')
  const sahte = path.join(TEST_DIR, 'svc20-secici.mjs')
  let svc, seed, fx
  before(async () => {
    seed = await startSeeder(); fx = seed.fx
    cleanService(sc)
    fs.mkdirSync(path.dirname(sahte), { recursive: true })
    // Sahte seçici: SECIM dosyasındaki yolu yazdırır (yok/boş = iptal), başlangıç klasörünü kaydeder
    fs.writeFileSync(sahte, `import fs from 'node:fs'
fs.writeFileSync(process.env.FAKE_SECIM + '.baslangic', process.env.OFFLINE_KLASOR_BASLANGIC || '')
let s = ''
try { s = fs.readFileSync(process.env.FAKE_SECIM, 'utf8') } catch {}
if (s === 'HATA') process.exit(3)
process.stdout.write(s)
`)
    fs.rmSync(secim, { force: true })
    Object.assign(sc.env, { OFFLINE_KLASOR_SECICI: sahte, FAKE_SECIM: secim })
    svc = await startService(sc)
  })
  after(async () => { await svc?.stop(); killAll(); for (const p of [secim, secim + '.baslangic', sahte, path.join(TEST_DIR, 'svc20-dosya.txt')]) fs.rmSync(p, { force: true }); cleanService(sc) })

  test('klasör seçici: seçilen yol, iptal ve program hatası', async () => {
    fs.writeFileSync(secim, dirB)
    assert.deepEqual(await svc.api('POST', '/api/klasor-sec'), { path: dirB })
    assert.equal(fs.readFileSync(secim + '.baslangic', 'utf8'), dirA, 'pencere mevcut klasörde açılır')
    fs.writeFileSync(secim, '')
    assert.deepEqual(await svc.api('POST', '/api/klasor-sec'), { cancelled: true })
    fs.writeFileSync(secim, 'HATA')
    await assert.rejects(svc.api('POST', '/api/klasor-sec'), e => e.status === 502 && /elle/.test(e.body.err))
    fs.writeFileSync(secim, 'goreli\\yol')
    await assert.rejects(svc.api('POST', '/api/klasor-sec'), e => e.status === 502)
    await assert.rejects(svc.api('GET', '/api/klasor-sec'), e => e.status === 405)
    // Seçmek ayarı değiştirmez; değiştirmek ayrı bir adımdır
    assert.equal((await svc.api('GET', '/api/settings')).downloadDir, dirA)
  })

  test('geçersiz klasör reddedilir ve ayar değişmez', async () => {
    for (const bad of ['', 'goreli', 5, null, secim]) {
      await assert.rejects(svc.api('POST', '/api/settings', { downloadDir: bad }), e => e.status === 400 && !!e.body.err, JSON.stringify(bad))
    }
    assert.equal((await svc.api('GET', '/api/settings')).downloadDir, dirA)
    await assert.rejects(svc.api('POST', '/api/settings', { downloadDir: dirB, uploadLimit: -3 }), e => e.status === 400)
    assert.equal((await svc.api('GET', '/api/settings')).downloadDir, dirA, 'geçersiz alan varsa hiçbiri uygulanmaz')
  })

  let filmDosya, klipDosya
  test('yeni klasör yalnız yeni indirmelere uygulanır; süren indirme eski yerinde sürer', async () => {
    const ih = fx.film.infoHash
    await svc.api('POST', '/api/items', { infoHash: ih, files: [0], type: 'movie', id: 'tt0000001' })
    await waitFor(async () => (await svc.item(ih)).doneBytes > 4 * MiB, { what: 'film inmeye başladı' })
    filmDosya = path.join(dirA, FILM.name)
    assert.ok(fs.existsSync(filmDosya), 'film A klasöründe')
    // Klasörü değiştir (yeni klasör oluşturulur)
    const r = await svc.api('POST', '/api/settings', { downloadDir: dirB })
    assert.equal(r.downloadDir, dirB)
    assert.ok(fs.statSync(dirB).isDirectory())
    assert.equal((await svc.api('GET', '/api/status')).downloadDir, dirB)
    // Süren indirmeyi duraklat/sürdür: motor yeniden başlar ama A'ya yazmaya devam etmeli
    const d0 = (await svc.item(ih)).doneBytes
    await svc.api('POST', `/api/items/${ih}/pause`)
    await svc.api('POST', `/api/items/${ih}/resume`)
    await waitFor(async () => { const i = await svc.item(ih); return i.state === 'downloading' && i.doneBytes > d0 }, { what: 'sürdürünce ilerledi' })
    assert.ok(!fs.existsSync(path.join(dirB, FILM.name)), 'film B klasörüne yazılmadı')
    // Yeni indirme B'ye iner
    const kih = fx.klip.infoHash
    await svc.api('POST', '/api/items', { infoHash: kih, files: [0], type: 'movie', id: 'tt0000004' })
    klipDosya = path.join(dirB, KLIP.name)
    await waitFor(async () => (await svc.item(kih)).state === 'completed', { timeout: 60000, what: 'klip bitti' })
    assert.ok(fs.existsSync(klipDosya), 'klip B klasöründe')
    assert.ok(!fs.existsSync(path.join(dirA, KLIP.name)), 'klip A klasörüne yazılmadı')
    assert.equal((await svc.item(kih)).files[0].path, klipDosya)
    assert.ok(readSource(klipDosya, 0, MiB).equals(readSource(sourcePath('klip'), 0, MiB)))
  })

  test('eski indirme bitince A klasöründe; oynatma ve kütüphane her iki klasörde çalışır', async () => {
    const ih = fx.film.infoHash
    const it = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 90000, what: 'film bitti' })
    assert.equal(it.files[0].path, filmDosya)
    assert.ok(!fs.existsSync(path.join(dirB, FILM.name)))
    const r = await readRange(`${svc.base}/play/movie/tt0000001/${ih}/0`, 1000, 1000 + MiB - 1)
    assert.equal(r.status, 206)
    assert.ok(r.buf.equals(readSource(sourcePath('film'), 1000, MiB)), 'A klasöründeki film oynar')
    const r2 = await readRange(`${svc.base}/play/movie/tt0000004/${fx.klip.infoHash}/0`, 0, MiB - 1)
    assert.ok(r2.buf.equals(readSource(sourcePath('klip'), 0, MiB)), 'B klasöründeki klip oynar')
    const lib = await svc.api('GET', '/api/library')
    assert.equal(lib.downloadDir, dirB)
    assert.equal(lib.items.length, 2)
    // Stremio ucu: ikisi de "Offline Hazır"
    for (const [id, h] of [['tt0000001', ih], ['tt0000004', fx.klip.infoHash]]) {
      const s = await svc.api('GET', `/stream/movie/${id}.json`)
      assert.ok(s.streams.some(x => x.name.includes('Offline') && x.url.includes(h)), id)
    }
  })

  test('kalıcı: servis yeniden başlayınca ayar sürer, eski öğeler bozulmaz; kayıtta öğenin klasörü var', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(sc.dataDir, 'ayarlar.json'), 'utf8'))
    assert.equal(saved.downloadDir, dirB)
    const lib = JSON.parse(fs.readFileSync(path.join(sc.dataDir, 'library.json'), 'utf8'))
    assert.equal(lib.items.find(i => i.infoHash === fx.film.infoHash).downloadDir, dirA)
    assert.equal(lib.items.find(i => i.infoHash === fx.klip.infoHash).downloadDir, dirB)
    await svc.stop()
    svc = await startService(sc) // ortam değişkeni hâlâ A'yı gösterir; kayıtlı seçim kazanır
    assert.equal((await svc.api('GET', '/api/settings')).downloadDir, dirB)
    const r = await readRange(`${svc.base}/play/movie/tt0000001/${fx.film.infoHash}/0`, 0, 1023)
    assert.equal(r.status, 206)
  })

  test('silme her öğeyi kendi klasöründe siler', async () => {
    await svc.api('DELETE', `/api/items/${fx.film.infoHash}`)
    assert.ok(!fs.existsSync(filmDosya), 'A klasöründeki film silindi')
    assert.ok(fs.existsSync(klipDosya), 'B klasöründeki klip yerinde')
    await svc.api('DELETE', `/api/items/${fx.klip.infoHash}`)
    assert.ok(!fs.existsSync(klipDosya))
  })

  test('kayıtlı klasör artık kullanılamıyorsa servis varsayılanla açılır, dosyadaki değer ezilmez', async () => {
    await svc.stop()
    const f = path.join(sc.dataDir, 'ayarlar.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    j.downloadDir = path.join(TEST_DIR, 'svc20-dosya.txt', 'alt') // dosyanın altı: oluşturulamaz
    fs.writeFileSync(path.join(TEST_DIR, 'svc20-dosya.txt'), 'x')
    fs.writeFileSync(f, JSON.stringify(j))
    svc = await startService(sc)
    assert.equal((await svc.api('GET', '/api/settings')).downloadDir, dirA)
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).downloadDir, j.downloadDir)
  })
})
