// rqbit yardimcilari: yerel (127.0.0.1) tohumlayici + indirici baslat/durdur + HTTP cagri.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { KOK, DIZIN } from './fixture.mjs'

export const RQBIT = path.join(KOK, 'bin', 'rqbit.exe')
export const sleep = ms => new Promise(r => setTimeout(r, ms))
const procs = new Map()

// Internetsiz calisma: DHT/tracker/LSD/UPnP kapali, peer ve API 127.0.0.1'e bagli.
export function baslat({ ad, api, port, cikti, oturum, ek = [], global = [] }) {
  fs.mkdirSync(cikti, { recursive: true }); fs.mkdirSync(path.join(DIZIN, 'log'), { recursive: true })
  const args = ['--http-api-listen-addr', `127.0.0.1:${api}`, '--listen-ip', '127.0.0.1', '--listen-port', String(port),
    '--disable-dht', '--disable-dht-persistence', '--disable-upnp-port-forward', '--disable-trackers', '--disable-lsd',
    '--ipv4-only', ...global, '--log-file', path.join(DIZIN, 'log', ad + '.log'),
    'server', 'start', ...(oturum ? ['--persistence-location', oturum] : ['--disable-persistence']), ...ek, cikti]
  // genel secenekler 'server'dan once, sunucu secenekleri sonra; ek global secenekler icin kok argumanlari kullanin
  const err = fs.openSync(path.join(DIZIN, 'log', ad + '.err'), 'a')
  const p = spawn(RQBIT, args, { stdio: ['ignore', 'ignore', err], windowsHide: true })
  procs.set(ad, p)
  return { ad, api, port, pid: p.pid, base: `http://127.0.0.1:${api}`, proc: p }
}
export async function hazirBekle(s, ms = 15000) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { const r = await fetch(s.base + '/'); if (r.ok) return Date.now() - t } catch {} ; await sleep(100) }
  throw new Error('rqbit ayaga kalkmadi: ' + s.ad)
}
export function oldur(s) { try { process.kill(s.pid) } catch {} ; procs.delete(s.ad) }
export function hepsiniDurdur() { for (const p of procs.values()) { try { p.kill() } catch {} } procs.clear() }
process.on('exit', hepsiniDurdur)

export async function http(s, method, yol, govde, opts = {}) {
  const t = performance.now()
  const r = await fetch(s.base + yol, { method, body: govde, headers: opts.headers, signal: opts.signal })
  const buf = Buffer.from(await r.arrayBuffer())
  const metin = buf.toString('utf8')
  let json; try { json = JSON.parse(metin) } catch {}
  return { status: r.status, ms: Math.round(performance.now() - t), json, metin: metin.slice(0, 400) }
}
export const stats = (s, id) => http(s, "GET", `/torrents/${id}/stats/v1`)

// ---- yerel senaryo yardimcilari ----
import { DIZIN as _D } from './fixture.mjs'
export const SEED = { api: 3051, port: 4251 }
export const T = { buyuk: path.join(_D, 'torrent', 'buyuk.torrent'), paket: path.join(_D, 'torrent', 'paket.torrent') }
// infoHash'ler uretilen .torrent dosyalarindan okunur (fixture.mjs once calistirilmali)
import { parseTorrent } from '../../lib/bencode.mjs'
export const IH = { get buyuk() { return parseTorrent(fs.readFileSync(T.buyuk)).infoHash }, get paket() { return parseTorrent(fs.readFileSync(T.paket)).infoHash } }
export const KAYNAK = path.join(_D, 'kaynak')
export const q = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')

// Tohumlayici: kaynak dosyalarin bulundugu klasore bakar, iki torrenti ekler (hash dogrulama saniyeler surer).
export async function tohumla() {
  const s = baslat({ ad: 'seed', api: SEED.api, port: SEED.port, cikti: KAYNAK })
  await hazirBekle(s)
  for (const f of ['buyuk', 'paket']) {
    const r = await http(s, 'POST', '/torrents?overwrite=true', fs.readFileSync(T[f]))
    if (r.status !== 200) throw new Error('tohum ekleme: ' + r.metin)
  }
  await sleep(1500)
  return s
}
// Indirici: ayri oturum klasoru, 4 MB/s indirme siniri (varsayilan), tohumlayiciya acik peer verilir.
export function indirici(ad, { api, port, oturum = true, hiz = 4 * 1048576, up, temiz = true } = {}) {
  const kok = path.join(_D, ad)
  const global = []
  if (hiz) global.push('--ratelimit-download', String(hiz))
  if (up !== undefined) global.push('--ratelimit-upload', String(up))
  return baslat({ ad, api, port, cikti: path.join(kok, 'cikti'), oturum: oturum ? path.join(kok, 'oturum') : null, global })
}
export function sil(...yollar) { for (const y of yollar) fs.rmSync(y, { recursive: true, force: true }) }
export const peer = `127.0.0.1:${SEED.port}`
