// İndirme klasörü: doğrulama ve Windows klasör seçme penceresi.
import fs from 'node:fs'
import path from 'node:path'
import { calistir, sistemYolu } from './arac.mjs'
import { log } from './log.mjs'

const hata = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }) }

/**
 * Windows'ta "Denetimli klasör erişimi" (fidye yazılımı koruması) Videolar, Belgeler gibi korumalı klasörlere
 * izinsiz programın yazmasını engeller; program bunu ENOENT/EPERM/EACCES ya da rqbit'te "os error 2/5" olarak görür.
 * Kullanıcıya okunur yol: başka klasör seç ya da programlara izin ver. Güvenlik ayarına biz dokunmayız.
 */
export function korumaIpucu (programlar = []) {
  const liste = [...new Set([process.execPath, ...programlar].filter(Boolean))].join(' ve ')
  return 'Windows Güvenliği\'ndeki "Denetimli klasör erişimi" bu klasöre yazmayı engelliyor olabilir. ' +
    'Ya korumasız bir klasör seç (örneğin D:\\Filmler) ya da Windows Güvenliği → Virüs ve tehdit koruması → ' +
    'Fidye yazılımı korumasını yönet → "Denetimli klasör erişimi üzerinden uygulamaya izin ver" bölümünden şunlara izin ver: ' + liste + '.'
}

/** Var olan bir klasöre yazma bu kodla düştüyse en olası neden Denetimli klasör erişimidir (yalnız Windows). */
export function yazmaEngeliMi (kodYaDaMesaj) {
  if (process.platform !== 'win32') return false
  const s = String(kodYaDaMesaj || '')
  return /^(ENOENT|EPERM|EACCES)$/.test(s) || /\(os error (2|5)\)/.test(s)
}

/**
 * Klasör yolunu doğrular: mutlak olmalı, yoksa oluşturulabilmeli, yazılabilmeli (deneme dosyası yazılıp silinir).
 * Dönüş: normalleştirilmiş mutlak yol. Hatalıysa anlaşılır Türkçe hata (status 400).
 */
export function denetleKlasor (girdi, { programlar = [] } = {}) {
  if (typeof girdi !== 'string' || !girdi.trim()) hata('İndirme klasörü boş olamaz')
  let ham = girdi.trim()
  if (/^".*"$/.test(ham)) ham = ham.slice(1, -1).trim() // Gezgin'den "Yol olarak kopyala"
  if (!ham || ham.length > 400 || ham.includes('\0')) hata('İndirme klasörü yolu geçersiz')
  const tam = process.platform === 'win32' ? /^([a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/])/.test(ham) : path.isAbsolute(ham)
  if (!tam) hata('İndirme klasörü tam yol olmalı, örneğin D:\\Filmler')
  const yol = path.resolve(ham)
  try { fs.mkdirSync(yol, { recursive: true }) } catch (e) {
    hata(`Klasör yok ve oluşturulamadı (${e.code || e.message}). Sürücü bağlı mı, yolu doğru yazdın mı?`)
  }
  let st
  try { st = fs.statSync(yol) } catch (e) { hata(`Klasöre erişilemiyor (${e.code || e.message})`) }
  if (!st.isDirectory()) hata('Bu yol bir klasör değil')
  const deneme = path.join(yol, `.offline-yazma-denemesi-${process.pid}-${Date.now()}.tmp`)
  try {
    fs.writeFileSync(deneme, 'x', { flag: 'wx' })
    fs.rmSync(deneme, { force: true })
  } catch (e) {
    try { fs.rmSync(deneme, { force: true }) } catch {}
    if (yazmaEngeliMi(e.code)) hata(`Bu klasöre yazılamıyor (${e.code}). ` + korumaIpucu(programlar))
    hata(`Bu klasöre yazılamıyor (${e.code || e.message}). Yazma izni olan başka bir klasör seç.`)
  }
  return yol
}

// Pencere kullanıcının masaüstünde açılır; en önde (TopMost) sahip form sayesinde diğer pencerelerin arkasında kalmaz.
const PS_BETIGI = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$sahip = New-Object System.Windows.Forms.Form
$sahip.TopMost = $true
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Yeni indirmeler için klasör seç'
$d.ShowNewFolderButton = $true
if ($env:OFFLINE_KLASOR_BASLANGIC -and (Test-Path -LiteralPath $env:OFFLINE_KLASOR_BASLANGIC)) { $d.SelectedPath = $env:OFFLINE_KLASOR_BASLANGIC }
if ($d.ShowDialog($sahip) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
$sahip.Dispose()
`

let acik = false

/**
 * POST /api/klasor-sec: seçilen yol { path } ya da iptalde { cancelled: true }.
 * Program: cfg.folderPicker (OFFLINE_KLASOR_SECICI; stdout'a seçilen yolu yazar, boş = iptal).
 * Sınama kipinde bu değişken yoksa gerçek pencere açılmaz (503).
 */
export async function klasorSec (cfg, baslangic) {
  if (acik) hata('Klasör seçme penceresi zaten açık', 409)
  let program, args
  if (cfg.folderPicker) { program = cfg.folderPicker; args = [] } else if (cfg.testMode) {
    hata('Sınama kipinde klasör seçme penceresi kapalı (OFFLINE_KLASOR_SECICI verilmedi)', 503)
  } else if (process.platform !== 'win32') hata('Klasör seçme penceresi yalnız Windows\'ta var; yolu elle yaz', 501)
  else {
    program = sistemYolu('WindowsPowerShell', 'v1.0', 'powershell.exe')
    args = ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(PS_BETIGI, 'utf16le').toString('base64')]
  }
  acik = true
  try {
    let r
    try { r = await calistir(program, args, { env: { OFFLINE_KLASOR_BASLANGIC: baslangic || '' }, timeoutMs: 5 * 60 * 1000 }) } catch (e) {
      log('klasör seçici başlatılamadı:', e.message)
      hata('Klasör seçme penceresi açılamadı; yolu elle yazabilirsin', 502)
    }
    if (r.timedOut) return { cancelled: true }
    if (r.code !== 0) {
      log('klasör seçici hata verdi:', r.code, r.stderr.slice(0, 300))
      hata('Klasör seçme penceresi hata verdi; yolu elle yazabilirsin', 502)
    }
    const yol = r.stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).find(Boolean)
    if (!yol) return { cancelled: true }
    if (!path.isAbsolute(yol)) hata('Seçici geçersiz bir yol döndürdü', 502)
    return { path: path.resolve(yol) }
  } finally { acik = false }
}
