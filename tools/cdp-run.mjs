// Kullanım: node cdp2.mjs senaryo.mjs  — senaryo: export default async ({ send, ev, sleep }) => {...}
import { pathToFileURL } from 'node:url'
const list = await (await fetch('http://127.0.0.1:11481/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('web.stremio.com'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let n = 0; const waits = new Map()
ws.onmessage = m => { const d = JSON.parse(m.data); if (waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id) } }
const send = (method, params = {}) => new Promise(res => { const id = ++n; waits.set(id, d => res(d.result ?? d.error)); ws.send(JSON.stringify({ id, method, params })) })
const ev = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'istisna'); return r.result.value }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const mod = await import(pathToFileURL(process.argv[2]).href)
try { const out = await mod.default({ send, ev, sleep }); console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1)) } catch (e) { console.log('HATA:', e.message) }
ws.close(); process.exit(0)
