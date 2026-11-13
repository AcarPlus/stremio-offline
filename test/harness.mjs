// Sınama düzeneği: yerel (127.0.0.1) tohumlayıcı rqbit + servis örnekleri. İnternet kullanılmaz.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_DIR, SOURCE, PACK, makeFixtures } from './fixture.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RQBIT = path.join(ROOT, 'bin', 'rqbit.exe')
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const MiB = 1024 * 1024

const children = new Set()
function track (p) { children.add(p); p.on('exit', () => children.delete(p)); return p }
export function killAll () { for (const p of children) { try { p.kill() } catch {} } children.clear() }
process.on('exit', killAll)

export async function waitFor (fn, { timeout = 30000, interval = 200, what = 'koşul' } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(interval)
  }
  throw new Error(`zaman aşımı: ${what} (son: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)})`)
}

export function rqbitArgs ({ api, port, out, session }) {
  return ['--http-api-listen-addr', `127.0.0.1:${api}`, '--listen-ip', '127.0.0.1', '--listen-port', String(port),
    '--disable-dht', '--disable-dht-persistence', '--disable-upnp-port-forward', '--disable-trackers', '--disable-lsd', '--ipv4-only',
    'server', 'start', ...(session ? ['--persistence-location', session] : ['--disable-persistence']), out]
}

export async function rq (base, method, p, body) {
  const r = await fetch(base + p, { method, body })
  const t = await r.text()
  let j; try { j = JSON.parse(t) } catch {}
  if (!r.ok) { const e = new Error(`${r.status} ${t.slice(0, 200)}`); e.status = r.status; throw e }
  return j ?? t
}

async function ready (base, ms = 15000) {
  await waitFor(async () => (await fetch(base + '/')).ok, { timeout: ms, what: 'rqbit hazır ' + base })
}

/** Ayrı bir rqbit örneği (tohumlayıcı ya da "sömürücü" eş). */
export async function startRqbit ({ name, api, port, out }) {
  fs.mkdirSync(out, { recursive: true })
  const logDir = path.join(TEST_DIR, 'log'); fs.mkdirSync(logDir, { recursive: true })
  const err = fs.openSync(path.join(logDir, name + '.err'), 'a')
  const p = track(spawn(RQBIT, rqbitArgs({ api, port, out }), { stdio: ['ignore', 'ignore', err], windowsHide: true }))
  fs.closeSync(err)
  const base = `http://127.0.0.1:${api}`
  await ready(base)
  return { name, base, port, proc: p, stop: () => { try { p.kill() } catch {} } }
}

export const SEED = { api: 3161, port: 4361 }
export const SEED_PEER = `127.0.0.1:${SEED.port}`

/** Tohumlayıcı: fixture'ları üretir, iki torrenti de tam olarak sunar. */
export async function startSeeder () {
  const fx = makeFixtures()
  const s = await startRqbit({ name: 'seed', ...SEED, out: path.join(TEST_DIR, 'seed-out') })
  await rq(s.base, 'POST', `/torrents?overwrite=true&output_folder=${encodeURIComponent(SOURCE)}`, fx.film.torrent)
  await rq(s.base, 'POST', `/torrents?overwrite=true&output_folder=${encodeURIComponent(path.join(SOURCE, PACK.name))}`, fx.pack.torrent)
  await waitFor(async () => {
    const a = await rq(s.base, 'GET', `/torrents/${fx.film.infoHash}/stats/v1`)
    const b = await rq(s.base, 'GET', `/torrents/${fx.pack.infoHash}/stats/v1`)
    return a.finished && b.finished && a.state === 'live' && b.state === 'live'
  }, { what: 'tohumlayıcı hazır' })
  return { ...s, fx }
}

/** Sessiz eş: bağlantıyı kabul eder, hiç konuşmaz (metadata hiç gelmez). */
export function silentPeer (port) {
  const socks = new Set()
  const srv = net.createServer(s => { socks.add(s); s.on('error', () => {}); s.on('close', () => socks.delete(s)) })
  srv.listen(port, '127.0.0.1')
  return { close: () => { for (const s of socks) s.destroy(); srv.close() } }
}

/**
 * Servis örneği. n: örnek numarası (kapılar ondan türetilir). Veri ve indirme klasörü TEST_DIR altında.
 */
export function serviceConfig (n, extra = {}) {
  const dataDir = path.join(TEST_DIR, 'svc' + n, 'data')
  const downloadDir = path.join(TEST_DIR, 'svc' + n, 'indirilenler')
  return {
    n,
    dataDir,
    downloadDir,
    port: 11590 + n,
    rqbitPort: 3170 + n,
    peerPort: 4370 + n,
    env: {
      OFFLINE_DATA_DIR: dataDir,
      OFFLINE_DOWNLOAD_DIR: downloadDir,
      OFFLINE_PORT: String(11590 + n),
      OFFLINE_RQBIT_PORT: String(3170 + n),
      OFFLINE_PEER_PORT: String(4370 + n),
      OFFLINE_LOOPBACK: '1',
      OFFLINE_NO_INJECT: '1',
      OFFLINE_STDIN_CONTROL: '1',
      OFFLINE_EXTRA_PEERS: SEED_PEER,
      OFFLINE_RATELIMIT_DOWN: String(4 * MiB),
      OFFLINE_POLL_MS: '300',
      OFFLINE_TORRENTIO_URL: 'http://127.0.0.1:9', // sınamada Torrentio'ya gidilmez
      ...extra
    }
  }
}

export function cleanService (sc) { fs.rmSync(path.join(TEST_DIR, 'svc' + sc.n), { recursive: true, force: true }) }

export async function startService (sc) {
  fs.mkdirSync(sc.dataDir, { recursive: true })
  const out = fs.openSync(path.join(sc.dataDir, '..', 'stdout.log'), 'a')
  const p = track(spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, env: { ...process.env, ...sc.env }, stdio: ['pipe', out, out], windowsHide: true
  }))
  fs.closeSync(out)
  const base = `http://127.0.0.1:${sc.port}`
  const svc = {
    base,
    proc: p,
    rqbit: `http://127.0.0.1:${sc.rqbitPort}`,
    async api (method, p2, body) {
      const r = await fetch(base + p2, { method, body: body === undefined ? undefined : JSON.stringify(body) })
      const t = await r.text()
      let j; try { j = JSON.parse(t) } catch {}
      if (!r.ok) { const e = new Error(`${method} ${p2} -> ${r.status} ${t.slice(0, 300)}`); e.status = r.status; e.body = j; throw e }
      return j
    },
    item (ih) { return this.api('GET', '/api/items/' + ih) },
    /** Temiz kapanış (stdin "kapat"): servis rqbit'i de kapatır. */
    async stop () {
      if (p.exitCode !== null) return
      try { p.stdin.write('kapat\n') } catch {}
      await waitFor(() => p.exitCode !== null, { timeout: 10000, what: 'servis kapandı' }).catch(() => p.kill())
      await waitFor(async () => { try { await fetch(svc.rqbit + '/', { signal: AbortSignal.timeout(500) }); return false } catch { return true } }, { timeout: 10000, what: 'rqbit kapandı' })
    },
    /** Sert kapanış: yalnızca Node süreci öldürülür (rqbit yetim kalır, sonraki açılış kapatmalı). */
    async kill () {
      p.kill()
      await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeout: 5000, what: 'servis öldü' })
    }
  }
  await waitFor(async () => (await svc.api('GET', '/api/status')).engine.ready, { timeout: 30000, what: 'servis hazır' })
  return svc
}

/** Servisin rqbit'inde bu torrentin istatistiği (yoksa null). */
export async function engineStats (svc, ih) {
  try { return await rq(svc.rqbit, 'GET', `/torrents/${ih}/stats/v1`) } catch (e) { if (e.status === 404) return null; throw e }
}

export async function readRange (url, start, end) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, headers: r.headers, buf }
}

export { TEST_DIR, SOURCE }
