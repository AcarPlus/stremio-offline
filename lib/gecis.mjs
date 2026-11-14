// Tek motorlu düzenden (tek rqbit oturumu: data/rqbit/oturum/session.json + <infohash>.torrent) indirme
// başına süreç düzenine geçiş. Servis açılışında, motorlar başlamadan önce bir kez çalışır.
//
// Doğruluk kaynağı kütüphanedir (library.json: durum, seçili dosyalar, çıktı klasörü). Eski oturumdan yalnızca
// kütüphanede eksik kalanlar tamamlanır: .torrent baytları (data/torrents/ önbelleğinde yoksa), çıktı klasörü,
// seçili dosyalar. Sonra oturum klasörü SİLİNMEDEN "oturum.v1-yedek" adıyla kenara alınır (yeni motorlar
// oturum kalıcılığı kullanmaz). İnmekte olan öğeler kendi süreçlerinde aynı klasöre overwrite=true ile
// eklenir: rqbit diskteki veriyi doğrular ve kaldığı yerden sürer; duraklatılmışlar duraklatılmış kalır.
import fs from 'node:fs'
import path from 'node:path'
import { parseTorrent } from './bencode.mjs'
import { log } from './log.mjs'

export function migrateSession (cfg, library) {
  const dir = path.join(cfg.rqbitDir, 'oturum')
  const sessionFile = path.join(dir, 'session.json')
  if (!fs.existsSync(dir)) return null
  let session = {}
  try { session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) } catch (e) {
    if (fs.existsSync(sessionFile)) log('geçiş: eski session.json okunamadı (' + e.message + '); yalnızca kütüphane kullanılacak')
  }
  const byHash = new Map()
  for (const t of Object.values(session.torrents || {})) {
    if (t && /^[a-f0-9]{40}$/i.test(t.info_hash || '')) byHash.set(t.info_hash.toLowerCase(), t)
  }
  const report = { items: 0, torrentsRestored: 0, foldersRestored: 0, selectionsRestored: 0 }
  fs.mkdirSync(cfg.torrentDir, { recursive: true })
  for (const item of library.all()) {
    report.items++
    const ih = item.infoHash
    const t = byHash.get(ih)
    // .torrent önbelleği: önce data/torrents, yoksa eski oturumdaki kopya (internetsiz sürdürme için)
    const cache = path.join(cfg.torrentDir, ih + '.torrent')
    const old = path.join(dir, ih + '.torrent')
    if (!fs.existsSync(cache) && fs.existsSync(old)) {
      try { parseTorrent(fs.readFileSync(old)); fs.copyFileSync(old, cache); report.torrentsRestored++ } catch (e) { log('geçiş: torrent kopyalanamadı:', ih, e.message) }
    }
    if (t) {
      if (!item.outputFolder && t.output_folder) { item.outputFolder = path.normalize(t.output_folder); report.foldersRestored++ }
      const sel = (item.files || []).filter(f => f.selected && f.idx != null)
      if (!sel.length && Array.isArray(t.only_files) && t.only_files.length && !item.wantedFiles) {
        item.wantedFiles = t.only_files.map(Number).filter(Number.isInteger)
        report.selectionsRestored++
      }
    }
    item.inEngine = false
  }
  library.saveNow()
  let backup = path.join(cfg.rqbitDir, 'oturum.v1-yedek')
  if (fs.existsSync(backup)) backup += '-' + Date.now()
  try {
    fs.renameSync(dir, backup)
  } catch (e) {
    // Taşınamadıysa kopyala; eski klasör yerinde kalır (yeni motorlar onu okumaz)
    try { fs.cpSync(dir, backup, { recursive: true }) } catch {}
    log('geçiş: oturum klasörü taşınamadı (' + e.message + '), kopyalandı:', backup)
  }
  log(`geçiş: tek motorlu oturumdan indirme başına süreç düzenine geçildi (${report.items} öğe, ${byHash.size} eski torrent kaydı, ` +
    `${report.torrentsRestored} .torrent ve ${report.foldersRestored} klasör eski oturumdan tamamlandı); yedek: ${backup}`)
  return { ...report, backup }
}
