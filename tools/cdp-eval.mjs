// Kullanım: node cdp.mjs "<js ifadesi>"  veya  node cdp.mjs @dosya.js
import fs from 'node:fs'
let expr = process.argv[2]
if (expr.startsWith('@')) expr = fs.readFileSync(expr.slice(1), 'utf8')
const list = await (await fetch('http://127.0.0.1:11481/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('web.stremio.com'))
if (!page) { console.log('Stremio sayfası bulunamadı'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
ws.onerror = e => { console.log('ws hata', e.message || e); process.exit(1) }
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
ws.onmessage = m => {
  const d = JSON.parse(m.data)
  if (d.id !== 1) return
  const r = d.result
  if (r.exceptionDetails) console.log('İSTİSNA:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails))
  else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1))
  ws.close(); process.exit(0)
}
