// "Hepsi bitince bilgisayarı kapat" (GET/POST /api/kapat-zamanla). Bellekte tutulur: kalıcı DEĞİLDİR (servis yeniden
// başlayınca kapalı), tetiklenince kendini kapatır. NOT: POST /api/kapat servisi kapatır; bu ise bilgisayarı.
//
// Akış: anahtar açılır (etkin indirme yoksa reddedilir) → bütün etkin (resolving/downloading) indirmeler bitince
// ve açıldıktan sonra en az biri TAMAMLANMIŞSA `shutdown.exe /s /t 60` (Windows'un kendi geri sayımı) çalıştırılır →
// arayüz geri sayımı gösterir, "İptal" `shutdown.exe /a` çalıştırır.
//
// GÜVENLİK: gerçek shutdown.exe'ye yalnız şu koşulda gidilir: sınama kipi DEĞİL ve OFFLINE_KAPATMA_KOMUTU verilmemiş.
// OFFLINE_KAPATMA_KOMUTU verilmişse o program (aynı bağımsız değişkenlerle) çalışır. Sınama kipinde (OFFLINE_DATA_DIR)
// değişken yoksa hiçbir program çalışmaz, yalnızca günlüğe yazılır ("sahte" geri sayım): gerçek kapatma imkânsızdır.
import { calistir, sistemYolu } from './arac.mjs'
import { log } from './log.mjs'
import { UserError } from './manager.mjs'

export const GERI_SAYIM_SN = 60
export const MESAJ = 'Stremio Offline: indirmeler bitti, bilgisayar 60 saniye içinde kapanacak. İptal için İndirme Merkezi\'nde İptal\'e bas ya da komut satırında "shutdown /a" yaz.'

/** Çalıştırılacak program; null = hiçbir şey çalıştırma (sınama kipi, sahte). */
export function komutBul (cfg) {
  if (cfg.shutdownCmd) return cfg.shutdownCmd
  if (cfg.testMode) return null
  return sistemYolu('shutdown.exe')
}

const etkin = i => i.state === 'downloading' || i.state === 'resolving'

export class Kapatma {
  /** run: sınama için değiştirilebilir (program, args) -> { code, stderr } */
  constructor ({ cfg, manager, run = calistir, now = () => Date.now() }) {
    this.cfg = cfg
    this.manager = manager
    this.run = run
    this.now = now
    this.phase = 'kapali' // kapali | bekliyor | geri-sayim
    this.armedAt = 0
    this.bos = 0 // ardışık "etkin indirme yok" gözlemi
    this.endsAt = 0
    this.simulated = false
    this.mesaj = null
    this.timer = null
    this.resetTimer = null
  }

  start () {
    this.timer = setInterval(() => this.tick(), this.cfg.shutdownCheckMs || 2000)
    this.timer.unref?.()
  }

  stop () { clearInterval(this.timer); clearTimeout(this.resetTimer) }

  etkinSayi () { return this.manager.lib.all().filter(etkin).length }

  durum () {
    const geri = this.phase === 'geri-sayim'
    return {
      armed: this.phase === 'bekliyor',
      countdown: geri,
      phase: this.phase,
      secondsLeft: geri ? Math.max(0, Math.ceil((this.endsAt - this.now()) / 1000)) : null,
      endsAt: geri ? this.endsAt : null,
      active: this.etkinSayi(),
      simulated: this.simulated,
      message: this.mesaj
    }
  }

  /** Anahtarı açar. Etkin indirme yoksa 409 (bkz. docs/api.md: açılışta hemen kapanma/hiç kapanmama belirsizliği olmasın). */
  arm () {
    if (this.phase !== 'kapali') return this.durum()
    if (!this.etkinSayi()) throw new UserError('Etkin indirme yok: kapatma anahtarı yalnızca bir indirme sürerken açılabilir (indirmeler bitince bilgisayar kapanır).', 409)
    this.phase = 'bekliyor'
    this.armedAt = this.now()
    this.bos = 0
    this.mesaj = null
    log('⏻ kapatma zamanlandı: indirmeler bitince bilgisayar kapatılacak')
    return this.durum()
  }

  /** Anahtarı kapatır; geri sayım sürüyorsa `shutdown /a` ile iptal eder. */
  async disarm () {
    if (this.phase === 'geri-sayim') {
      if (!this.simulated) {
        const prog = komutBul(this.cfg)
        let r
        try { r = await this.run(prog, ['/a'], { timeoutMs: 15000 }) } catch (e) { r = { code: -1, stderr: e.message } }
        // 1116: zaten iptal edilmiş / kapatma sürmüyor; bu da "iptal edildi" demektir
        if (r.code !== 0 && r.code !== 1116) {
          log('kapatma iptal edilemedi:', r.code, String(r.stderr || '').slice(0, 200))
          throw new UserError('Kapatma iptal edilemedi. Komut istemine "shutdown /a" yazarak iptal et.', 502)
        }
      }
      log('⏻ kapatma iptal edildi')
    } else if (this.phase === 'bekliyor') log('⏻ kapatma zamanlaması kapatıldı')
    clearTimeout(this.resetTimer)
    this.phase = 'kapali'
    this.simulated = false
    this.mesaj = null
    return this.durum()
  }

  /** Düzenli denetim (cfg.shutdownCheckMs; 2 ardışık "etkin indirme yok" gözlemi gerekir: geçici boşluklar tetiklemesin). */
  async tick () {
    if (this.phase !== 'bekliyor') return
    if (this.etkinSayi()) { this.bos = 0; return }
    if (++this.bos < 2) return
    const bitti = this.manager.lib.all().some(i => i.state === 'completed' && (i.completedAt || 0) >= this.armedAt)
    if (!bitti) {
      // Hiçbir indirme tamamlanmadan etkin kalmadı (duraklatıldı/iptal/hata): sessizce kapatma, anahtarı da bırakma
      this.phase = 'kapali'
      this.mesaj = 'Hiçbir indirme tamamlanmadan etkin indirme kalmadı (duraklatıldı, iptal edildi ya da hata verdi); bilgisayar kapatılmadı, anahtar kapatıldı.'
      log('⏻ kapatma zamanlaması bırakıldı: tamamlanan indirme yok')
      return
    }
    await this.tetikle()
  }

  async tetikle () {
    const prog = komutBul(this.cfg)
    this.phase = 'geri-sayim'
    this.endsAt = this.now() + GERI_SAYIM_SN * 1000
    this.simulated = !prog
    this.mesaj = null
    // Geri sayım bittiyse (bilgisayar kapanmadıysa: sahte komut, iptal vb.) durumu sıfırla
    clearTimeout(this.resetTimer)
    this.resetTimer = setTimeout(() => { if (this.phase === 'geri-sayim') { this.phase = 'kapali'; this.simulated = false } }, GERI_SAYIM_SN * 1000 + 15000)
    this.resetTimer.unref?.()
    if (!prog) { log('⏻ [sınama kipi] indirmeler bitti; kapatma komutu çalıştırılmadı (sahte geri sayım)'); return }
    log('⏻ indirmeler bitti; bilgisayar', GERI_SAYIM_SN, 'sn içinde kapanacak:', prog)
    let r
    try { r = await this.run(prog, ['/s', '/t', String(GERI_SAYIM_SN), '/c', MESAJ], { timeoutMs: 20000 }) } catch (e) { r = { code: -1, stderr: e.message } }
    if (r.code !== 0 && this.phase === 'geri-sayim') {
      clearTimeout(this.resetTimer)
      this.phase = 'kapali'
      this.mesaj = 'Kapatma komutu çalışmadı (' + String(r.stderr || r.code).trim().slice(0, 150) + '); bilgisayar kapatılmadı.'
      log('kapatma komutu başarısız:', r.code, String(r.stderr || '').slice(0, 200))
    }
  }
}
