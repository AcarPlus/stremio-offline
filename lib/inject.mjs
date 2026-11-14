// Stremio başlatıcıyla (hata ayıklama kapısı açık) çalışıyorsa inject.js'i Stremio arayüzüne yükler.
// Kapı düzenli yoklanır: Stremio sonradan açılırsa, yeniden başlarsa ya da sayfası yenilenirse
// betik kendiliğinden yeniden yüklenir. Servis yeniden başlarsa sayfadaki eski betik yeni sürümle
// değiştirilir (betik `__SURUM__` ile kendini tanır; farklıysa eskisini söküp yenisini kurar).
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from './log.mjs'

/** inject.js kaynağını servis adresi ve sürüm damgasıyla hazırlar. */
export function buildSource (raw, base) {
  const surum = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10)
  return raw.replaceAll('__API__', base).replaceAll('__SURUM__', surum)
}

export function startInjector (cfg, { intervalMs = 3000 } = {}) {
  const injected = new Map() // hedef kimliği -> WebSocket
  async function tick () {
    let targets
    try {
      targets = await (await fetch(`http://127.0.0.1:${cfg.debugPort}/json`, { signal: AbortSignal.timeout(1500) })).json()
    } catch { return }
    for (const t of targets) {
      if (t.type !== 'page' || !String(t.url).startsWith('https://web.stremio.com') || injected.has(t.id)) continue
      let source
      try { source = buildSource(await fsp.readFile(path.join(cfg.root, 'inject.js'), 'utf8'), cfg.base) } catch { return }
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      injected.set(t.id, ws)
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }))
        // Sayfa yenilenirse de yeniden yüklensin; şu anki sayfaya da hemen uygula.
        ws.send(JSON.stringify({ id: 2, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source } }))
        ws.send(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: source } }))
        log('Stremio arayüzüne indirme düğmeleri eklendi')
      }
      ws.onclose = ws.onerror = () => injected.delete(t.id)
    }
  }
  const timer = setInterval(() => tick().catch(() => {}), intervalMs)
  tick().catch(() => {})
  return () => { clearInterval(timer); for (const ws of injected.values()) { try { ws.close() } catch {} } }
}
