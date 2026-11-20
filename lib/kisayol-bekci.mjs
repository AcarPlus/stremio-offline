// Kısayol bekçisi: Stremio güncellenince kurulum programı kendi "Stremio.lnk"'ini yeniden yazar (doğrudan Stremio
// programına, düğmesiz açılır). Bekçi kisayol-onar.ps1'i çalıştırır; betik kısayolu yine bizim başlatıcıya çevirir.
//
// Ne zaman çalışır:
//  - açılıştan ~30 sn sonra ve 10 dakikada bir;
//  - kısayol klasörlerinde (masaüstü, Başlat menüsü; data/kurulum.json'dan) adı "Stremio" ile başlayan bir .lnk
//    değişince ~5 sn sonra (fs.watch; süreç başlatmadan, Windows'un klasör bildirimiyle). Güncelleme anında olan şey
//    tam olarak bu dosyanın yeniden yazılmasıdır; kaldırma kaydındaki sürümü yoklamak her seferinde reg.exe/powershell
//    başlatmayı gerektirirdi ve dolaylı bir işaret olurdu. İzleme kurulamazsa 10 dakikalık yoklama yine yeter.
// data/kurulum.json yoksa (kur.ps1 çalıştırılmamış / kaldırılmış) betik hiç başlatılmaz.
// Aynı anda tek çalıştırma; çalışırken gelen istek bitince bir kez daha çalıştırılır. Hata servisi düşürmez.
// Sınama kipinde (OFFLINE_DATA_DIR) varsayılan kapalı: OFFLINE_KISAYOL_BEKCI=1 ile açılır (=0 her yerde kapatır).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { log } from './log.mjs'

export function bekciAcikMi (cfg, env = process.env) {
  if (process.platform !== 'win32') return false
  if (env.OFFLINE_KISAYOL_BEKCI === '1') return true
  if (env.OFFLINE_KISAYOL_BEKCI === '0') return false
  return !cfg.testMode
}

function kurulumOku (file) {
  try {
    const t = fs.readFileSync(file, 'utf8')
    const v = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t)
    return v && typeof v === 'object' && v.klasorler ? v : null
  } catch { return null }
}

/**
 * @returns {null | (() => void)} durdurma işlevi (kapalıysa null)
 * opts: env, ilkMs (30000), aralikMs (600000), gecikmeMs (5000), zamanAsimiMs (120000), onRun (sınama: her çalıştırmada çağrılır)
 */
export function startKisayolBekci (cfg, opts = {}) {
  const env = opts.env || process.env
  if (!bekciAcikMi(cfg, env)) return null
  const { ilkMs = 30000, aralikMs = 600000, gecikmeMs = 5000, zamanAsimiMs = 120000, onRun } = opts
  const betik = path.join(cfg.root, 'kisayol-onar.ps1')
  const kurulumDosyasi = path.join(cfg.dataDir, 'kurulum.json')
  let durdu = false
  let cocuk = null
  let bekleyen = false
  let gecikme = null
  let izleyiciler = []
  let izlenenAnahtar = ''

  function izleyicileriGuncelle (k) {
    const klasorler = k ? [[k.klasorler.masaustu, false], [k.klasorler.baslatMenusu, true]].filter(([d]) => typeof d === 'string' && d) : []
    const anahtar = JSON.stringify(klasorler)
    if (anahtar === izlenenAnahtar) return
    for (const w of izleyiciler) { try { w.close() } catch {} }
    izleyiciler = []
    izlenenAnahtar = anahtar
    for (const [d, recursive] of klasorler) {
      try {
        const w = fs.watch(d, { recursive, persistent: false }, (ev, ad) => {
          if (ad && /^stremio.*\.lnk$/i.test(path.basename(String(ad)))) planla()
        })
        w.on('error', () => {})
        izleyiciler.push(w)
      } catch (e) { log('kısayol klasörü izlenemiyor (10 dk yoklama sürer):', d, '-', e.message) }
    }
  }

  function planla (ms = gecikmeMs) {
    if (durdu) return
    clearTimeout(gecikme)
    gecikme = setTimeout(calistir, ms)
    gecikme.unref?.()
  }

  function calistir () {
    if (durdu) return
    const k = kurulumOku(kurulumDosyasi)
    izleyicileriGuncelle(k)
    if (!k) return
    if (cocuk) { bekleyen = true; return }
    let p
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', betik, '-VeriKlasoru', cfg.dataDir], { cwd: cfg.root, env, stdio: 'ignore', windowsHide: true })
    } catch (e) { log('kısayol onarımı başlatılamadı:', e.message); return }
    cocuk = p
    onRun?.()
    const sure = setTimeout(() => { log('kısayol onarımı zaman aşımı; durduruluyor'); try { p.kill() } catch {} }, zamanAsimiMs)
    sure.unref?.()
    let bitti = false
    const son = () => {
      if (bitti) return
      bitti = true
      clearTimeout(sure)
      cocuk = null
      if (bekleyen && !durdu) { bekleyen = false; planla() }
    }
    p.on('error', e => { log('kısayol onarımı başlatılamadı:', e.message); son() })
    p.on('exit', code => { if (code) log('kısayol onarımı hata kodu', code, '(ayrıntı: baslatici.log)'); son() })
  }

  planla(ilkMs)
  const aralik = setInterval(calistir, aralikMs)
  aralik.unref?.()
  return () => {
    durdu = true
    clearTimeout(gecikme)
    clearInterval(aralik)
    for (const w of izleyiciler) { try { w.close() } catch {} }
    izleyiciler = []
    if (cocuk) { try { cocuk.kill() } catch {} }
  }
}
