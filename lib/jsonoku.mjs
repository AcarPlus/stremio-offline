// JSON dosyası okuma: baştaki BOM (PowerShell 5 `Set-Content -Encoding utf8` yazar) soyulur;
// dosya yoksa sessizce { value: null, status: 'yok' }; ayrıştırılamıyorsa günlüğe yazılır ve dosya
// ezilmeden `<dosya>.bozuk-<zaman>` olarak yedeklenir ({ value: null, status: 'bozuk', backup }).
import fs from 'node:fs'
import { log } from './log.mjs'

export function stripBom (text) { return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text }

export function readJsonFile (file, { what = file } = {}) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return { value: null, status: 'yok' }
    log(what, 'okunamadı:', e.message)
    return { value: null, status: 'bozuk' }
  }
  try {
    const value = JSON.parse(stripBom(text))
    return { value, status: 'tamam' }
  } catch (e) {
    const backup = file + '.bozuk-' + Date.now()
    try { fs.copyFileSync(file, backup) } catch {}
    log(what, 'ayrıştırılamadı (' + e.message + '); yedeklendi:', backup, '- varsayılanlar kullanılıyor')
    return { value: null, status: 'bozuk', backup }
  }
}
