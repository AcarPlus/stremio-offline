// Zaman damgalı günlük; isteğe bağlı olarak dosyaya da yazar.
import fs from 'node:fs'

let file = null
export function setLogFile (f) {
  file = f
  try { if (fs.statSync(f).size > 5e6) fs.renameSync(f, f + '.old') } catch {}
}

export function log (...a) {
  const line = new Date().toLocaleTimeString('tr-TR') + ' ' + a.map(x => x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : JSON.stringify(x)).join(' ')
  console.log(line)
  if (file) { try { fs.appendFileSync(file, line + '\n') } catch {} }
}
