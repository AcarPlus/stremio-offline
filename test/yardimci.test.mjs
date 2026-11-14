// web/yardimci.js: İndirme Merkezi'nin saf yardımcıları (kalite grupları, hata/silme metni).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ctx = {}
ctx.globalThis = ctx
vm.runInNewContext(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'yardimci.js'), 'utf8'), ctx)
const y = ctx.OfflineYardimci

test('kalite: sıra dışı değerler en yakın gruba katılır, bilinmeyen ayrı (D3)', () => {
  assert.equal(y.qualityGroup('1080p'), '1080p')
  assert.equal(y.qualityGroup('4k'), '2160p')
  assert.equal(y.qualityGroup('2160p'), '2160p')
  assert.equal(y.qualityGroup('1226p'), '1080p', '1226p ayrı süzgeç düğmesi olmaz')
  assert.equal(y.qualityGroup('720p'), '720p')
  assert.equal(y.qualityGroup('576p'), '480p')
  assert.equal(y.qualityGroup('scr'), 'düşük')
  assert.equal(y.qualityGroup('CAM'), 'düşük')
  assert.equal(y.qualityGroup(''), null)
  assert.equal(y.qualityGroup(undefined), null)
  assert.equal(y.qualityGroup('other'), null)
  assert.equal(y.qualityLabel(undefined), 'Bilinmeyen')
  assert.equal(y.qualityLabel('1226p'), '1080p')
  assert.equal(y.qualityLabel('cam'), 'CAM/TS')
})

test('kalite sıralaması: bilinmeyen her iki yönde de sonda (D3)', () => {
  const list = ['720p', '', '1226p', '4k', 'other', '480p']
  const sorted = dir => [...list].sort((a, b) => y.compareQuality(a, b, dir))
  const hi = sorted(-1)
  assert.deepEqual(hi.slice(0, 4), ['4k', '1226p', '720p', '480p'])
  assert.ok(['', 'other'].includes(hi[4]) && ['', 'other'].includes(hi[5]))
  const lo = sorted(1)
  assert.deepEqual(lo.slice(0, 4), ['480p', '720p', '1226p', '4k'])
  assert.ok(['', 'other'].includes(lo[4]) && ['', 'other'].includes(lo[5]))
})

test('hata metni aynı öneriyi iki kez yazmaz (D4)', () => {
  const motor = 'Torrent bilgisi 90 sn içinde alınamadı. "Sürdür" ile yeniden denenebilir.'
  const t = y.errorText(motor)
  assert.equal(t, 'Sorun: ' + motor)
  assert.equal((t.match(/Sürdür/g) || []).length, 1)
  assert.match(y.errorText('Disk dolu'), /^Sorun: Disk dolu “Sürdür” ile yeniden deneyebilirsin\.$/)
  assert.match(y.errorText(''), /Bilinmeyen/)
})

test('silme iletişimi dosyaların diskten silineceğini ve torrent adını söyler (D5)', () => {
  const fmt = n => n + ' B'
  const t = y.deleteText({ displayName: 'Sintel', name: 'Sintel.2010.720p.YTS', sizeBytes: 1000 }, fmt)
  assert.match(t, /Sintel/)
  assert.match(t, /diskten silinir/)
  assert.match(t, /Sintel\.2010\.720p\.YTS/, 'aynı başlıklı iki sürüm ayırt edilir')
  assert.match(t, /1000 B/)
  assert.match(t, /kutuyu işaretle/)
  const same = y.deleteText({ name: 'X', sizeBytes: 0 }, fmt)
  assert.ok(!same.includes('Torrent:'), 'ad zaten gösteriliyorsa yinelenmez')
})
