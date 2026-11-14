// Geçiş: tek motorlu eski sürümün (git 780f59f) ürettiği gerçek veri (library.json + data/rqbit/oturum)
// yeni düzene (indirme başına süreç) kayıpsız taşınır. Eski sürüm git'ten geçici klasöre çıkarılıp
// aynı veri klasörüyle çalıştırılır; git ya da o commit yoksa sınama atlanır.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  startSeeder, startService, serviceConfig, cleanService, engineOf, waitFor, rq, killAll, MiB, ROOT, TEST_DIR
} from './harness.mjs'
import { FILM, KLIP, PACK, sourcePath, readSource } from './fixture.mjs'

const ESKI = '780f59f' // indirme başına süreçten önceki son commit
const OLD_DIR = path.join(TEST_DIR, 'eski-surum')

/** Eski sürümün dosyalarını git'ten çıkarır (çalışma ağacına ve depo ayarlarına dokunmaz). */
function extractOld () {
  const ls = spawnSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', ESKI], { encoding: 'utf8' })
  if (ls.status !== 0) return false
  fs.rmSync(OLD_DIR, { recursive: true, force: true })
  for (const f of ls.stdout.split('\n').map(s => s.trim()).filter(f => /^(server\.mjs|package\.json|inject\.js|lib\/|web\/)/.test(f))) {
    const r = spawnSync('git', ['-C', ROOT, 'show', `${ESKI}:${f}`], { maxBuffer: 64e6 })
    if (r.status !== 0) return false
    fs.mkdirSync(path.dirname(path.join(OLD_DIR, f)), { recursive: true })
    fs.writeFileSync(path.join(OLD_DIR, f), r.stdout)
  }
  return fs.existsSync(path.join(OLD_DIR, 'server.mjs'))
}

const haveOld = extractOld()

describe('geçiş: tek oturumdan indirme başına sürece', { skip: !haveOld && 'eski sürüm git\'ten çıkarılamadı' }, () => {
  const sc = serviceConfig(7)
  let seed, fx, svc
  const before0 = {}
  const seedUploaded = async ih => (await rq(seed.base, 'GET', `/torrents/${ih}/stats/v1`)).uploaded_bytes
  before(async () => { seed = await startSeeder(); fx = seed.fx; cleanService(sc) })
  after(async () => { await svc?.stop(); killAll(); cleanService(sc); fs.rmSync(OLD_DIR, { recursive: true, force: true }) })

  test('eski sürüm: bitmiş (seçili bölümler), duraklatılmış yarım, inmekte yarım indirme', async () => {
    const old = await startService(sc, { root: OLD_DIR })
    try {
      // Paket: yalnızca E01 ve E03 seçili, bitmiş
      await old.api('POST', '/api/items', { infoHash: fx.pack.infoHash, files: [0, 3], type: 'series', id: 'tt0000002:1:1' })
      await waitFor(async () => (await old.item(fx.pack.infoHash)).state === 'completed', { timeout: 60000, what: 'paket bitti (eski)' })
      // Klip: yarımda duraklatıldı
      await old.api('POST', '/api/items', { infoHash: fx.klip.infoHash, files: [0], type: 'movie', id: 'tt0000004' })
      await waitFor(async () => { const i = await old.item(fx.klip.infoHash); return i.state === 'downloading' && i.doneBytes > 3 * MiB }, { what: 'klip yarım' })
      await old.api('POST', `/api/items/${fx.klip.infoHash}/pause`)
      // Film: inerken servis kapanır
      await old.api('POST', '/api/items', { infoHash: fx.film.infoHash, files: [0], type: 'movie', id: 'tt0000001' })
      await waitFor(async () => { const i = await old.item(fx.film.infoHash); return i.state === 'downloading' && i.doneBytes > FILM.size * 0.3 }, { timeout: 60000, what: 'film %30 (eski)' })
      for (const t of ['film', 'klip', 'pack']) before0[t] = await old.item(fx[t].infoHash)
    } finally { await old.stop() }
    const sess = JSON.parse(fs.readFileSync(path.join(sc.dataDir, 'rqbit', 'oturum', 'session.json'), 'utf8'))
    const hashes = Object.values(sess.torrents || {}).map(t => t.info_hash)
    assert.equal(hashes.length, 3, 'eski düzen: üç torrent tek oturumda')
    const first = Object.values(sess.torrents)[0]
    console.log('  eski session.json kaydı alanları:', Object.keys(first).join(', '))
    assert.ok('output_folder' in first && 'only_files' in first, 'geçişin okuduğu alanlar var')
    // Önbellekte .torrent'i olmayan bir öğe: geçiş eski oturumdaki kopyayı kullanmalı (internetsiz sürdürme)
    fs.rmSync(path.join(sc.dataDir, 'torrents', fx.klip.infoHash + '.torrent'), { force: true })
    console.log(`  eski: film %${before0.film.percent}, klip %${before0.klip.percent} (duraklatılmış), paket %${before0.pack.percent}`)
  })

  test('yeni sürüm: oturum yedeklenir, durumlar/seçimler/klasörler korunur, film kaldığı yerden sürer', async () => {
    const up0 = await seedUploaded(fx.film.infoHash)
    svc = await startService(sc)
    const rq0 = path.join(sc.dataDir, 'rqbit')
    assert.ok(!fs.existsSync(path.join(rq0, 'oturum')), 'eski oturum klasörü kullanılmıyor')
    assert.ok(fs.existsSync(path.join(rq0, 'oturum.v1-yedek', 'session.json')), 'eski oturum silinmeden yedeklendi')
    assert.ok(fs.existsSync(path.join(rq0, 'oturum.v1-yedek', fx.film.infoHash + '.torrent')))
    assert.ok(fs.existsSync(path.join(sc.dataDir, 'torrents', fx.klip.infoHash + '.torrent')), '.torrent eski oturumdan geri kondu')

    const pack = await svc.item(fx.pack.infoHash)
    assert.equal(pack.state, 'completed')
    assert.deepEqual(pack.files.filter(f => f.selected).map(f => f.idx), [0, 3], 'seçili dosyalar korunur')
    assert.equal(pack.files.find(f => f.idx === 0).path, before0.pack.files.find(f => f.idx === 0).path)
    const klip = await svc.item(fx.klip.infoHash)
    assert.equal(klip.state, 'paused', 'duraklatılmışlık korunur')
    assert.equal(klip.doneBytes, before0.klip.doneBytes)
    for (const ih of [fx.pack.infoHash, fx.klip.infoHash]) assert.equal(await engineOf(svc, ih), null, 'bitmiş/duraklatılmış için süreç yok')
    for (const t of ['film', 'klip', 'pack']) assert.equal((await svc.item(fx[t].infoHash)).downloadLimit, 4 * MiB, 'eski öğeler varsayılan sınırı alır')

    // Film kendi sürecinde, aynı klasöre eklenip doğrulanır ve kaldığı yerden sürer
    await waitFor(async () => (await engineOf(svc, fx.film.infoHash))?.ready, { what: 'film motoru' })
    const done = await waitFor(async () => { const i = await svc.item(fx.film.infoHash); return i.state === 'completed' && i }, { timeout: 60000, what: 'film bitti (yeni)' })
    const fetched = (await seedUploaded(fx.film.infoHash)) - up0
    console.log(`  film: geçişten sonra inen ${(fetched / MiB).toFixed(1)} MiB (önce inmiş ${(before0.film.doneBytes / MiB).toFixed(1)} MiB)`)
    assert.ok(fetched <= FILM.size - before0.film.doneBytes + 4 * MiB, 'baştan indirilmemeli')
    assert.equal(done.files[0].path, before0.film.files[0].path, 'aynı dosya yolu')
    for (const ofs of [0, Math.floor(FILM.size / 2), FILM.size - MiB]) assert.ok(readSource(done.files[0].path, ofs, MiB).equals(readSource(sourcePath('film'), ofs, MiB)))
    // Bitmiş paket diskten oynar
    const r = await fetch(`${svc.base}/play/series/tt0000002:1:3/${fx.pack.infoHash}/3`, { headers: { Range: 'bytes=0-1023' } })
    assert.equal(r.status, 206)
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(readSource(sourcePath('pack', 3), 0, 1024)))
  })

  test('taşınan duraklatılmış yarım indirme sürdürülünce kaldığı yerden tamamlanır', async () => {
    const ih = fx.klip.infoHash
    const up0 = await seedUploaded(ih)
    await svc.api('POST', `/api/items/${ih}/resume`)
    const done = await waitFor(async () => { const i = await svc.item(ih); return i.state === 'completed' && i }, { timeout: 60000, what: 'klip bitti' })
    const fetched = (await seedUploaded(ih)) - up0
    console.log(`  klip: sürdürünce inen ${(fetched / MiB).toFixed(1)} MiB / ${KLIP.size / MiB} MiB`)
    assert.ok(fetched <= KLIP.size - before0.klip.doneBytes + 4 * MiB, 'var olan kısım yeniden indirilmemeli')
    assert.equal(done.files[0].path, before0.klip.files[0].path)
    assert.ok(readSource(done.files[0].path, KLIP.size - MiB, MiB).equals(readSource(sourcePath('klip'), KLIP.size - MiB, MiB)))
    assert.equal(PACK.files.length, 5)
  })
})
