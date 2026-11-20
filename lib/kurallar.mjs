// İndirme kuralları ve bakım (Ayarlar sayfası):
//   kuyruk   aynı anda en çok maxConcurrent indirme; fazlası "Sırada" bekler, biri bitince sıradaki başlar
//   saat     scheduleOn ise yalnız scheduleStart–scheduleEnd arasında indirilir (gece yarısını aşabilir)
//   disk     diskte minFreeGB'den az yer kalınca indirmeler durur; yer açılınca (+1 GiB pay) sürer
//   bildirim indirme bitince Windows bildirimi (notifyOnComplete)
//   silme    deleteWatchedDays > 0 ise son oynatılmasından o kadar gün geçmiş bitmiş indirme silinir
//   otomatik başlatma: Başlangıç klasöründeki "Stremio Offline Servis" kısayolu aç/kapat
//
// Kuralın duraklattığı öğede item.autoPaused nedeni tutulur (kullanıcı duraklatırsa null olur ve kural o
// öğeyi bir daha sürdürmez). Oynatılan indirmeye ve elle sürdürülene (item.elleSurdur) saat/kuyruk kuralı
// dokunmaz; disk kuralı oynatılmayan her indirmeye uygulanır.
//
// Sınama: OFFLINE_KURAL_MS (denetim aralığı), OFFLINE_BILDIRIM_KOMUTU (bildirim programı; sınama kipinde yoksa
// bildirim gösterilmez), OFFLINE_BASLANGIC_KLASORU (sınama kipinde yoksa otomatik başlatma değiştirilemez),
// OFFLINE_KLASOR_ACICI (günlük klasörünü açan program; sınama kipinde yoksa açılmaz).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { calistir, sistemYolu } from './arac.mjs'
import { log } from './log.mjs'
import { readJsonFile } from './jsonoku.mjs'

const GiB = 2 ** 30
const DAY = 864e5
const hata = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }) }
const etkin = i => i.state === 'downloading' || i.state === 'resolving'

/** "SS:DD" -> gün içindeki dakika. */
export function dakika (s) { const [h, m] = String(s).split(':').map(Number); return h * 60 + m }

/** Verilen an izinli saat aralığında mı? Başlangıç = bitiş ise bütün gün. Gece yarısını aşan aralık desteklenir. Saf. */
export function saatIcinde (date, start, end) {
  const a = dakika(start); const b = dakika(end); const t = date.getHours() * 60 + date.getMinutes()
  if (a === b) return true
  return a < b ? t >= a && t < b : t >= a || t < b
}

const BILDIRIM_BETIGI = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Text = 'Stremio Offline'
$n.BalloonTipTitle = $env:SO_BASLIK
$n.BalloonTipText = $env:SO_METIN
$n.Visible = $true
$n.ShowBalloonTip(8000)
Start-Sleep -Seconds 9
$n.Dispose()
`

const KISAYOL_BETIGI = `
$k = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SO_LNK)
$k.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'
$k.Arguments = $env:SO_ARG
$k.WorkingDirectory = $env:SO_KOK
$k.WindowStyle = 7
$k.Description = 'Offline İndir servisini oturum açılırken gizli başlatır'
$k.Save()
`
const ps = betik => ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(betik, 'utf16le').toString('base64')]

export class Kurallar {
  constructor ({ cfg, manager, settings, klip = null, env = process.env }) {
    this.cfg = cfg
    this.M = manager
    this.settings = settings
    this.klip = klip
    this.env = env
    this.everyMs = Number(env.OFFLINE_KURAL_MS) || 15000
    this.diskFree = null
    this.diskDusuk = false
    this.busy = false
    this.lastDelete = 0
    // Başlangıç klasörü: kur.ps1'in kullandığı (data/kurulum.json), yoksa Windows'un varsayılanı
    const kurulum = fs.existsSync(path.join(cfg.dataDir, 'kurulum.json')) ? readJsonFile(path.join(cfg.dataDir, 'kurulum.json'), { what: 'kurulum.json' }).value : null
    this.startupDir = env.OFFLINE_BASLANGIC_KLASORU || (cfg.testMode ? null : (kurulum?.klasorler?.baslangic ||
      path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')))
    manager.ruleGate = item => this.gate(item)
    manager.onComplete = item => { this.bildir(item); setImmediate(() => this.tick().catch(() => {})) }
    manager.onSettingsChanged = () => setImmediate(() => this.tick().catch(() => {}))
  }

  start () {
    this.timer = setInterval(() => this.tick().catch(e => log('kural denetimi:', e.message)), this.everyMs)
    this.timer.unref?.()
    setTimeout(() => this.tick().catch(e => log('kural denetimi:', e.message)), 2000).unref?.()
    return this
  }

  stop () { clearInterval(this.timer) }

  saatDisi (g = this.settings.genel()) { return !!g.scheduleOn && !saatIcinde(new Date(this.M.now()), g.scheduleStart, g.scheduleEnd) }

  /** Yeni bir indirme şimdi başlayabilir mi? null = evet, yoksa bekleme nedeni. */
  gate (item) {
    const g = this.settings.genel()
    if (this.diskDusuk) return 'disk'
    if (this.saatDisi(g)) return 'saat'
    const limit = g.maxConcurrent || Infinity
    const n = this.M.lib.all().filter(i => i !== item && etkin(i)).length
    return n >= limit ? 'kuyruk' : null
  }

  async olcDisk (g) {
    if (!(g.minFreeGB > 0)) { this.diskDusuk = false; return }
    try {
      const s = await fsp.statfs(this.cfg.downloadDir)
      this.diskFree = s.bavail * s.bsize
    } catch { return }
    const min = g.minFreeGB * GiB
    if (this.diskFree < min) {
      if (!this.diskDusuk) log(`💽 diskte yer az (${(this.diskFree / GiB).toFixed(1)} GiB < ${g.minFreeGB} GiB): indirmeler durduruluyor`)
      this.diskDusuk = true
    } else if (this.diskDusuk && this.diskFree >= min + GiB) {
      log('💽 diskte yer açıldı: indirmeler sürüyor')
      this.diskDusuk = false
    }
  }

  async tick () {
    if (this.busy) return
    this.busy = true
    try {
      const g = this.settings.genel()
      const M = this.M
      const all = () => M.lib.all()
      const oynuyor = i => M.isPlaying(i)
      await this.olcDisk(g)
      if (this.diskDusuk) for (const i of all().filter(etkin)) if (!oynuyor(i)) await this.durdur(i, 'disk')
      const saatDisi = this.saatDisi(g)
      if (saatDisi) for (const i of all().filter(etkin)) if (!oynuyor(i) && !i.elleSurdur) await this.durdur(i, 'saat')
      const limit = g.maxConcurrent || Infinity
      let act = all().filter(etkin)
      if (act.length > limit) {
        const kurban = act.filter(i => !i.priority && !i.elleSurdur && !oynuyor(i)).sort((a, b) => b.addedAt - a.addedAt)
        while (act.length > limit && kurban.length) { await this.durdur(kurban.shift(), 'kuyruk'); act = all().filter(etkin) }
      }
      // Bekleyenler: öncelikli önce, sonra eklenme sırası
      const bekleyen = all().filter(i => i.state === 'paused' && i.autoPaused).sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || a.addedAt - b.addedAt)
      for (const i of bekleyen) {
        const neden = this.diskDusuk ? 'disk' : saatDisi ? 'saat' : null
        if (neden) { if (i.autoPaused !== neden) { i.autoPaused = neden; M.lib.save() } continue }
        if (all().filter(etkin).length >= limit) { if (i.autoPaused !== 'kuyruk') { i.autoPaused = 'kuyruk'; M.lib.save() } continue }
        try { await M.resume(i.infoHash, { auto: true }); log('▶ kural sürdürdü:', i.name || i.title || i.infoHash) } catch (e) { log('kural sürdüremedi:', e.message) }
      }
      if (g.deleteWatchedDays > 0 && M.now() - this.lastDelete > 10 * 60 * 1000) { this.lastDelete = M.now(); await this.izlenenleriSil(g.deleteWatchedDays) }
    } finally { this.busy = false }
  }

  async durdur (item, neden) {
    try { await this.M.pause(item.infoHash, { auto: neden }) } catch (e) { log('kural duraklatamadı:', e.message) }
  }

  /** Son oynatılmasından `gun` gün geçmiş bitmiş indirmeleri siler (dosyalarıyla). */
  async izlenenleriSil (gun) {
    const sinir = this.M.now() - gun * DAY
    for (const i of this.M.lib.all()) {
      if (i.state !== 'completed' || !i.lastPlayedAt || i.lastPlayedAt > sinir || this.M.isPlaying(i)) continue
      log(`🗑 izlenmiş, ${gun} gün geçti, siliniyor:`, i.displayName || i.name || i.infoHash)
      try { await this.M.remove(i.infoHash, { keepFiles: false }) } catch (e) { log('silinemedi:', e.message) }
    }
  }

  // ------------------------------------------------------------ bildirim

  bildir (item) {
    if (!this.settings.genel().notifyOnComplete) return
    const ad = item.displayName || item.name || item.title || 'İndirme'
    const env = { SO_BASLIK: 'İndirme bitti', SO_METIN: ad + ' internetsiz izlenmeye hazır.' }
    let program; let args
    if (this.env.OFFLINE_BILDIRIM_KOMUTU) { program = this.env.OFFLINE_BILDIRIM_KOMUTU; args = [] } else if (this.cfg.testMode || process.platform !== 'win32') return
    else { program = sistemYolu('WindowsPowerShell', 'v1.0', 'powershell.exe'); args = ps(BILDIRIM_BETIGI) }
    calistir(program, args, { env, timeoutMs: 30000 }).catch(e => log('bildirim gösterilemedi:', e.message))
  }

  // ------------------------------------------------------------ bakım

  /** Klipleri ve geçici klip dosyalarını siler (çalışan iş hariç). Dönüş: { freedBytes }. */
  async klipTemizle () {
    if (!this.klip) return { freedBytes: 0 }
    return this.klip.hepsiniSil()
  }

  /** Günlük (veri) klasörünü Gezgin'de açar. */
  async gunlukAc () {
    const yol = this.cfg.dataDir
    let program
    if (this.env.OFFLINE_KLASOR_ACICI) program = this.env.OFFLINE_KLASOR_ACICI
    else if (this.cfg.testMode) hata('Sınama kipinde klasör açılmaz (OFFLINE_KLASOR_ACICI verilmedi)', 503)
    else if (process.platform !== 'win32') hata('Yalnız Windows\'ta', 501)
    else program = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
    calistir(program, [yol], { timeoutMs: 15000 }).catch(e => log('klasör açılamadı:', e.message))
    return { path: yol }
  }

  servisLnk () { return this.startupDir ? path.join(this.startupDir, 'Stremio Offline Servis.lnk') : null }

  /** { enabled, available, path } */
  otoBaslat () {
    const lnk = this.servisLnk()
    return { available: !!lnk, enabled: !!lnk && fs.existsSync(lnk), path: lnk }
  }

  async otoBaslatAyarla (enabled) {
    if (typeof enabled !== 'boolean') hata('enabled: true ya da false olmalı')
    const lnk = this.servisLnk()
    if (!lnk) hata('Sınama kipinde otomatik başlatma değiştirilemez (OFFLINE_BASLANGIC_KLASORU verilmedi)', 503)
    if (!enabled) {
      await fsp.rm(lnk, { force: true })
      log('otomatik başlatma kapatıldı')
      return this.otoBaslat()
    }
    if (fs.existsSync(lnk)) return this.otoBaslat()
    // kur.ps1'deki "Stremio Offline Servis" kısayolunun aynısı: wscript baslat-servis.vbs "<node>"
    const kok = this.cfg.root
    const arg = `//B //Nologo "${path.join(kok, 'baslat-servis.vbs')}" "${process.execPath}"` // ortak.ps1 Get-BizimArgumanlar
    if (this.env.OFFLINE_KISAYOL_YAZICI) {
      await calistir(this.env.OFFLINE_KISAYOL_YAZICI, [], { env: { SO_LNK: lnk, SO_ARG: arg, SO_KOK: kok } })
    } else if (process.platform !== 'win32') hata('Yalnız Windows\'ta', 501)
    else {
      fs.mkdirSync(path.dirname(lnk), { recursive: true })
      const r = await calistir(sistemYolu('WindowsPowerShell', 'v1.0', 'powershell.exe'), ps(KISAYOL_BETIGI), { env: { SO_LNK: lnk, SO_ARG: arg, SO_KOK: kok } })
      if (r.code !== 0) hata('Kısayol oluşturulamadı: ' + (r.stderr || r.code).toString().trim().slice(0, 200), 500)
    }
    log('otomatik başlatma açıldı:', lnk)
    return this.otoBaslat()
  }

  durum () {
    const g = this.settings.genel()
    return { diskLow: this.diskDusuk, diskFreeBytes: this.diskFree, offHours: this.saatDisi(g), autostart: this.otoBaslat() }
  }
}
