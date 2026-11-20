// Dış program çalıştırma yardımcısı (klasör seçici, kapatma komutu). Sınamalarda bu programlar ortam
// değişkeniyle sahte bir betiğe yönlendirilir: ".mjs/.js" ile biten yol node ile, diğerleri doğrudan çalıştırılır.
import { spawn } from 'node:child_process'
import path from 'node:path'

const isScript = p => /\.(mjs|cjs|js)$/i.test(p)

/** Dönüş: { code, stdout, stderr, timedOut }. Başlatılamazsa reddeder. */
export function calistir (program, args = [], { env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, argv] = isScript(program) ? [process.execPath, [program, ...args]] : [program, args]
    let p
    try {
      p = spawn(cmd, argv, { env: env ? { ...process.env, ...env } : process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { return reject(e) }
    let stdout = ''; let stderr = ''; let timedOut = false
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
    p.stdout.on('data', d => { if (stdout.length < 1e5) stdout += d })
    p.stderr.on('data', d => { if (stderr.length < 1e5) stderr += d })
    const t = setTimeout(() => { timedOut = true; try { p.kill() } catch {} }, timeoutMs)
    p.on('error', e => { clearTimeout(t); reject(e) })
    p.on('close', code => { clearTimeout(t); resolve({ code, stdout, stderr, timedOut }) })
  })
}

/** Windows sistem klasöründeki bir program (ör. powershell.exe ve kapatma programı). */
export function sistemYolu (...parcalar) {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parcalar)
}
