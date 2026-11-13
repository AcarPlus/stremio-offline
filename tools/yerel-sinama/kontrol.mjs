// Faz 0b rqbit islevsel kontrolleri (yerel dongu, internetsiz). Kullanim: node tools/yerel-sinama/kontrol.mjs 1 2 3 ...
// Onkosul: node tools/yerel-sinama/fixture.mjs  (yukleri ve .torrent dosyalarini uretir)
import fs from 'node:fs'
import path from 'node:path'
import { DIZIN, BOYUT } from './fixture.mjs'
import { baslat, hazirBekle, http, oldur, sleep, stats, tohumla, indirici, sil, q, T, IH, KAYNAK, peer, hepsiniDurdur } from './rq.mjs'

const mb = n => (n / 1048576).toFixed(1) + ' MiB'
const log = (...a) => console.log(...a)
const kes = (o, n = 300) => (typeof o === 'string' ? o : JSON.stringify(o)).slice(0, n)
const kaynakBuyuk = path.join(KAYNAK, 'Buyuk.Film.2160p.mkv')

function kaynaktanOku(dosya, ofs, n) {
  const fd = fs.openSync(dosya, 'r'); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, ofs); fs.closeSync(fd); return b
}
// Range istegi: ilk bayta kadar gecen sure (TTFB) ve istenen bayt sayisi okunana kadar gecen sure
async function aralik(s, id, idx, bas, n) {
  const t = performance.now()
  const r = await fetch(`${s.base}/torrents/${id}/stream/${idx}`, { headers: { Range: `bytes=${bas}-${bas + n - 1}` } })
  const baslik = Math.round(performance.now() - t)
  const parcalar = []; let ttfb = null
  for await (const c of r.body) { if (ttfb === null) ttfb = Math.round(performance.now() - t); parcalar.push(c) }
  const buf = Buffer.concat(parcalar)
  return { status: r.status, ttfb, baslik, toplam: Math.round(performance.now() - t), len: buf.length, buf,
    basliklar: { 'content-range': r.headers.get('content-range'), 'content-length': r.headers.get('content-length'), 'accept-ranges': r.headers.get('accept-ranges'), 'content-type': r.headers.get('content-type') } }
}

const kontroller = {
  async 1() {
    const seed = await tohumla(); const d = indirici('dl1', { api: 3052, port: 4252 })
    try {
      await hazirBekle(d)
      const ekle = `/torrents?${q({ initial_peers: peer, output_folder: path.join(DIZIN, 'dl1', 'cikti') })}`
      log('ISTEK POST', ekle, '[.torrent baytlari]')
      const r = await http(d, 'POST', ekle, fs.readFileSync(T.buyuk)); log(r.status, r.ms + 'ms', kes(r.json?.details?.files ?? r.metin))
      const id = r.json.id
      const n = 1048576
      // 1a: bastan
      const a = await aralik(d, id, 0, 0, n)
      const esit = a.buf.equals(kaynaktanOku(kaynakBuyuk, 0, n))
      log('1a ISTEK GET /torrents/%s/stream/0 Range: bytes=0-%d', id, n - 1, '->', a.status, 'baslik', a.baslik + 'ms', 'ilk-bayt', a.ttfb + 'ms', 'toplam', a.toplam + 'ms', 'len', a.len, 'ESIT', esit, JSON.stringify(a.basliklar))
      // 1b: %70 konumu; once o parca indirilmis mi (haves) bak
      const boyut = BOYUT.buyuk; const ofs = Math.floor(boyut * 0.7 / 1048576) * 1048576 + 12345
      const pieceNo = Math.floor(ofs / 1048576)
      const hv = await fetch(`${d.base}/torrents/${id}/haves`); const hb = Buffer.from(await hv.arrayBuffer())
      log('haves: bayt', hb.length, 'ilk 16 bayt', hb.subarray(0, 16).toString('hex'), 'content-type', hv.headers.get('content-type'))
      const st0 = (await stats(d, id)).json
      log('seek oncesi progress', mb(st0.progress_bytes), 'state', st0.state, 'hiz', JSON.stringify(st0.live?.download_speed))
      const b = await aralik(d, id, 0, ofs, n)
      const esitB = b.buf.equals(kaynaktanOku(kaynakBuyuk, ofs, n))
      log('1b ISTEK Range: bytes=%d-%d (parca ~%d, %%70)', ofs, ofs + n - 1, pieceNo, '->', b.status, 'baslik', b.baslik + 'ms', 'ilk-bayt', b.ttfb + 'ms', 'toplam', b.toplam + 'ms', 'len', b.len, 'ESIT', esitB, JSON.stringify(b.basliklar))
      const st1 = (await stats(d, id)).json
      log('seek sonrasi progress', mb(st1.progress_bytes), 'file_progress', st1.file_progress, 'canli stats', kes(st1.live, 700))
      // 1c: %70'ten sonra bir sure daha devam eden akis (ardisik 8 MiB) ve ortalama hiz
      const c = await aralik(d, id, 0, ofs + n, 8 * n)
      log('1c ardisik 8 MiB', c.status, 'ilk-bayt', c.ttfb, 'toplam', c.toplam + 'ms', 'ESIT', c.buf.equals(kaynaktanOku(kaynakBuyuk, ofs + n, 8 * n)))
      // 1d: dosya sonu ve gecersiz aralik
      const e = await aralik(d, id, 0, boyut - 1000, 1000)
      log('1d son 1000 bayt', e.status, 'ilk-bayt', e.ttfb, 'toplam', e.toplam, 'ESIT', e.buf.equals(kaynaktanOku(kaynakBuyuk, boyut - 1000, 1000)), e.basliklar['content-range'])
      const bad = await fetch(`${d.base}/torrents/${id}/stream/0`, { headers: { Range: `bytes=${boyut + 5}-` } }); log('aralik disi', bad.status, kes(await bad.text(), 120))
      const full = await fetch(`${d.base}/torrents/${id}/stream/0`); log('Range yok: ', full.status, full.headers.get('content-length'), full.headers.get('accept-ranges')); await full.body.cancel()
    } finally { oldur(d); oldur(seed) }
  },
  async 2() {
    const seed = await tohumla(); const d = indirici('dl2', { api: 3052, port: 4252 })
    try {
      await hazirBekle(d)
      const r = await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: path.join(DIZIN, 'dl2', 'cikti') }), fs.readFileSync(T.buyuk)); const id = r.json.id
      await sleep(4000)
      const s0 = (await stats(d, id)).json; log('calisirken: state', s0.state, 'progress', mb(s0.progress_bytes), 'hiz', s0.live?.download_speed?.human_readable)
      const p = await http(d, 'POST', '/torrents/' + id + '/pause'); log('ISTEK POST /torrents/%s/pause ->', id, p.status, p.ms + 'ms', p.metin)
      await sleep(1500)
      const a = (await stats(d, id)).json; await sleep(5000); const b = (await stats(d, id)).json
      log('duraklatildi: state', a.state, 'progress', mb(a.progress_bytes), '->', mb(b.progress_bytes), '(5 sn sonra) live alani', b.live === null ? 'null' : typeof b.live, 'tam stats', kes(b, 500))
      const l = await http(d, 'GET', '/torrents'); log('GET /torrents (paused)', kes(l.json, 300))
      const dt = await http(d, 'GET', '/torrents/' + id); log('GET /torrents/id', dt.status, kes(dt.json, 200))
      // duraklatilmisken stream
      const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 3000)
      try { const rr = await fetch(d.base + '/torrents/' + id + '/stream/0', { headers: { Range: 'bytes=500000000-500100000' }, signal: ac.signal }); const bb = await rr.arrayBuffer(); log('paused iken stream', rr.status, bb.byteLength) } catch (e) { log('paused iken stream: 3 sn icinde veri gelmedi (' + e.name + ')') } clearTimeout(tm)
      const g = await http(d, 'POST', '/torrents/' + id + '/start'); log('ISTEK POST /torrents/%s/start ->', id, g.status, g.ms + 'ms', g.metin)
      await sleep(1000); const c = (await stats(d, id)).json; await sleep(4000); const e = (await stats(d, id)).json
      log('surduruldu: state', c.state, 'progress', mb(c.progress_bytes), '->', mb(e.progress_bytes), 'hiz', e.live?.download_speed?.human_readable)
      const p2 = await http(d, 'POST', '/torrents/' + id + '/pause'); const p3 = await http(d, 'POST', '/torrents/' + id + '/pause'); log('cift pause', p2.status, p2.metin, '|', p3.status, p3.metin)
      const g2 = await http(d, 'POST', '/torrents/' + id + '/start'); const g3 = await http(d, 'POST', '/torrents/' + id + '/start'); log('cift start', g2.status, g2.metin, '|', g3.status, g3.metin)
    } finally { oldur(d); oldur(seed) }
  },

  async 3() {
    const seed = await tohumla(); sil(path.join(DIZIN, 'dl3'))
    let d = indirici('dl3', { api: 3052, port: 4252, hiz: 40 * 1048576 })
    try {
      await hazirBekle(d)
      const ekle = async (ad, yol) => (await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: path.join(DIZIN, 'dl3', 'cikti-' + ad) }), fs.readFileSync(T[ad]))).json
      const a = await ekle('buyuk'); const b = await ekle('paket'); log('eklendi ids', a.id, b.id)
      await http(d, 'POST', '/torrents/' + b.id + '/pause')
      await sleep(10000)
      const sa = (await stats(d, a.id)).json, sb = (await stats(d, b.id)).json
      log('oncesi: A', sa.state, mb(sa.progress_bytes), 'fetched', mb(sa.live?.snapshot?.fetched_bytes ?? 0), '| B', sb.state, mb(sb.progress_bytes))
      const diskA = fs.statSync(path.join(DIZIN, 'dl3', 'cikti-buyuk', 'Buyuk.Film.2160p.mkv')).size
      log('diskte buyuk dosya boyutu (onceden ayrilmis mi?)', mb(diskA))
      oldur(d); log('ISLEM: surec zorla oldurildu (TerminateProcess)'); await sleep(1000)
      const t0 = performance.now(); d = indirici('dl3', { api: 3052, port: 4252, hiz: 40 * 1048576, temiz: false })
      const ready = await hazirBekle(d); log('API hazir:', Math.round(performance.now() - t0), 'ms')
      const l = (await http(d, 'GET', '/torrents')).json; log('GET /torrents (yeniden baslatma sonrasi)', kes(l.torrents.map(t => ({ id: t.id, ih: t.info_hash.slice(0, 8), name: t.name })), 400))
      let live = null
      for (let i = 0; i < 100; i++) {
        const x = (await stats(d, a.id)).json; if (i < 3 || x.state !== (live?.state)) log('  t+', Math.round(performance.now() - t0), 'ms A state', x.state, 'progress', mb(x.progress_bytes)); live = x
        if (x.state === 'live') break; await sleep(100)
      }
      const t1 = Math.round(performance.now() - t0)
      log('A "live" oldu: t+' + t1 + ' ms, progress', mb(live.progress_bytes), '(oncesi', mb(sa.progress_bytes) + ')')
      const sb2 = (await stats(d, b.id)).json; log('B (oldurulmeden once pause idi) sonrasi state:', sb2.state, 'progress', mb(sb2.progress_bytes))
      await sleep(3000); const sa3 = (await stats(d, a.id)).json
      log('3 sn sonra A progress', mb(sa3.progress_bytes), 'fetched_bytes (bu oturum)', mb(sa3.live?.snapshot?.fetched_bytes ?? 0))
      log('yeniden baslatma sonrasi peer sayisi', sa3.live?.snapshot?.peer_stats?.live, '(initial_peers kalici degil mi?)')
      const ap = await http(d, 'POST', '/torrents/' + a.id + '/add_peers', peer + '\n'); log('ISTEK POST /torrents/%s/add_peers govde "%s" ->', a.id, peer, ap.status, ap.metin)
      await sleep(3000); const sa4 = (await stats(d, a.id)).json; log('add_peers sonrasi progress', mb(sa4.progress_bytes), 'peer', sa4.live?.snapshot?.peer_stats?.live, 'hiz', sa4.live?.download_speed?.human_readable)
      // id kararliligi: ilkini unut, yeniden baslat
      const f = await http(d, 'POST', '/torrents/' + a.id + '/forget'); log('forget A', f.status, f.metin)
      oldur(d); await sleep(1000); d = indirici('dl3', { api: 3052, port: 4252, hiz: 40 * 1048576, temiz: false }); await hazirBekle(d)
      const l2 = (await http(d, 'GET', '/torrents')).json; log('A unutulup yeniden baslatinca:', kes(l2.torrents.map(t => ({ id: t.id, ih: t.info_hash.slice(0, 8) })), 300))
      const ek = await http(d, 'POST', '/torrents?' + q({ output_folder: path.join(DIZIN, 'dl3', 'cikti-yeni') }), fs.readFileSync(T.buyuk)); log('yeni eklenen id', ek.json?.id, ek.status)
      oldur(d); await sleep(800); d = indirici('dl3', { api: 3052, port: 4252, hiz: 40 * 1048576, temiz: false }); await hazirBekle(d)
      log('son liste', kes((await http(d, 'GET', '/torrents')).json.torrents.map(t => ({ id: t.id, ih: t.info_hash.slice(0, 8) })), 300))
      const sess = path.join(DIZIN, 'dl3', 'oturum'); log('oturum klasoru:', fs.readdirSync(sess).map(f => f + ':' + fs.statSync(path.join(sess, f)).size))
    } finally { oldur(d); oldur(seed) }
  },
  async 4() {
    const seed = await tohumla(); sil(path.join(DIZIN, 'dl4')); const d = indirici('dl4', { api: 3052, port: 4252, hiz: 8 * 1048576 })
    const kl = path.join(DIZIN, 'dl4', 'cikti')
    const disk = () => fs.existsSync(kl) ? fs.readdirSync(kl).map(f => f + ':' + mb(fs.statSync(path.join(kl, f)).size)) : 'klasor yok'
    try {
      await hazirBekle(d)
      const ekle = '/torrents?' + q({ initial_peers: peer, output_folder: path.join(DIZIN, 'dl4', 'cikti'), only_files: '1' })
      log('ISTEK POST', ekle)
      const r = await http(d, 'POST', ekle, fs.readFileSync(T.paket)); log(r.status, r.ms + 'ms', kes(r.json?.details?.files?.map(f => [f.name, f.length, f.included]) ?? r.metin, 500)); const id = r.json.id
      await sleep(7000)
      let st = (await stats(d, id)).json; log('file_progress', st.file_progress, 'progress', mb(st.progress_bytes), 'total_bytes', mb(st.total_bytes)); log('diskte:', disk())
      const dt = (await http(d, 'GET', '/torrents/' + id)).json; log('GET /torrents/id files.included:', kes(dt.files.map(f => [f.name, f.included])))
      const u = await http(d, 'POST', '/torrents/' + id + '/update_only_files', JSON.stringify({ only_files: [1, 2] }), { headers: { 'content-type': 'application/json' } }); log('ISTEK POST update_only_files {"only_files":[1,2]} ->', u.status, u.metin)
      await sleep(8000)
      st = (await stats(d, id)).json; log('degisiklik sonrasi file_progress', st.file_progress, 'progress', mb(st.progress_bytes), 'total_bytes', mb(st.total_bytes)); log('diskte:', disk())
      const dt2 = (await http(d, 'GET', '/torrents/' + id)).json; log('included:', kes(dt2.files.map(f => [f.name, f.included])))
      // secimi daraltma: sadece 2 (idx 2)
      const u2 = await http(d, 'POST', '/torrents/' + id + '/update_only_files', JSON.stringify({ only_files: [2] }), { headers: { 'content-type': 'application/json' } }); log('daraltma [2] ->', u2.status, u2.metin)
      await sleep(3000); const dt3 = (await http(d, 'GET', '/torrents/' + id)).json; log('included:', kes(dt3.files.map(f => [f.name, f.included])))
      const st3 = (await stats(d, id)).json; log('file_progress', st3.file_progress, 'diskte:', disk())
      // sparse mi?
      const { execFileSync } = await import('node:child_process')
      for (const f of fs.readdirSync(kl)) { try { log('fsutil sparse', f, execFileSync('fsutil', ['sparse', 'queryflag', path.join(kl, f)]).toString().trim()) } catch (e) { log('fsutil hata', f) } }
      // regex ile secim denemesi
      const rx = await http(d, 'POST', '/torrents?' + q({ sub_folder: 'altklasor', only_files_regex: '[.]srt$', initial_peers: peer }), fs.readFileSync(T.paket)); log('only_files_regex=[.]srt$ ->', rx.status, kes(rx.json?.details?.files?.map(f => [f.name, f.included]) ?? rx.metin, 400))
    } finally { oldur(d); oldur(seed) }
  },

  async 5() {
    const seed = await tohumla(); sil(path.join(DIZIN, 'dl5')); const d = indirici('dl5', { api: 3052, port: 4252, hiz: 20 * 1048576 })
    const ls = p => fs.existsSync(p) ? (function w(x) { return fs.statSync(x).isDirectory() ? fs.readdirSync(x).flatMap(f => w(path.join(x, f))) : [path.relative(p, x) + ':' + mb(fs.statSync(x).size)] })(p) : 'YOK'
    const kokA = path.join(DIZIN, 'dl5', 'cikti-A'), kokB = path.join(DIZIN, 'dl5', 'cikti-B')
    try {
      await hazirBekle(d)
      const ekle = (ad, kok) => http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: kok }), fs.readFileSync(T[ad])).then(r => r.json)
      const A = await ekle('paket', kokA), B = await ekle('buyuk', kokB)
      await sleep(8000)
      log('once: A', ls(kokA), '| B', ls(kokB))
      const sA = (await stats(d, A.id)).json; log('forget oncesi A progress', mb(sA.progress_bytes), '/', mb(sA.total_bytes))
      const f = await http(d, 'POST', '/torrents/' + IH.paket + '/forget'); log('ISTEK POST /torrents/<infohash>/forget ->', f.status, f.metin)
      const dl = await http(d, 'POST', '/torrents/' + B.id + '/delete'); log('ISTEK POST /torrents/%s/delete ->', B.id, dl.status, dl.metin)
      await sleep(500)
      log('forget sonrasi A (dosyalar kalmali):', ls(kokA)); log('delete sonrasi B (dosyalar silinmeli):', ls(kokB), '| ust klasor:', fs.existsSync(kokB) ? fs.readdirSync(kokB) : 'YOK')
      log('liste:', kes((await http(d, 'GET', '/torrents')).json))
      const s1 = await http(d, 'GET', '/torrents/' + IH.paket + '/stats/v1'); log('unutulan torrent stats', s1.status, s1.metin.slice(0, 120))
      // forget sonrasi ayni torrenti ayni klasore tekrar ekle: overwrite olmadan ve olmadan
      const r1 = await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: kokA }), fs.readFileSync(T.paket)); log('forget sonrasi yeniden ekle (overwrite yok) ->', r1.status, kes(r1.metin, 400))
      const r2 = await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: kokA, overwrite: 'true' }), fs.readFileSync(T.paket)); log('forget sonrasi yeniden ekle (overwrite=true) ->', r2.status, kes(r2.json?.id ?? r2.metin, 200))
      for (let i = 0; i < 20 && r2.json; i++) { const x = (await stats(d, r2.json.id)).json; if (x.state === 'live') { log('  yeniden eklenen: state', x.state, 'progress', mb(x.progress_bytes), '(forget oncesi', mb(sA.progress_bytes) + ')'); break } await sleep(200) }
      const delA = await http(d, 'POST', '/torrents/' + IH.paket + '/delete'); log('delete A', delA.status, 'diskte:', ls(kokA), 'klasor:', fs.existsSync(kokA) ? fs.readdirSync(kokA) : 'YOK')
      // bitmemis dosyaya sahip olmayan: sadece liste disi
      const dd = await http(d, 'POST', '/torrents/' + 'ffffffffffffffffffffffffffffffffffffffff' + '/delete'); log('olmayan torrent delete ->', dd.status, dd.metin.slice(0, 120))
      const kokC = path.join(DIZIN, 'dl5', 'paylasimli'); fs.mkdirSync(kokC, { recursive: true }); fs.writeFileSync(path.join(kokC, 'baska-dosya.txt'), 'kullanicinin dosyasi')
      const C = await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: kokC }), fs.readFileSync(T.buyuk)); await sleep(1500)
      const dc = await http(d, 'POST', '/torrents/' + C.json.id + '/delete'); log('paylasimli klasorde delete ->', dc.status, 'klasor icerigi:', fs.existsSync(kokC) ? fs.readdirSync(kokC) : 'KLASOR YOK')
    } finally { oldur(d); oldur(seed) }
  },

  async 6() {
    const seed = await tohumla(); sil(path.join(DIZIN, 'dl6')); const d = indirici('dl6', { api: 3052, port: 4252, hiz: 4 * 1048576 })
    const kok = n => path.join(DIZIN, 'dl6', n)
    try {
      await hazirBekle(d)
      // 6a magnet + yerel peer
      const mg = `magnet:?xt=urn:btih:${IH.buyuk}&dn=Buyuk.Film.2160p.mkv`
      const ma = '/torrents?' + q({ initial_peers: peer, output_folder: kok('magnet') })
      log('6a ISTEK POST', ma, 'govde:', mg)
      const a = await http(d, 'POST', ma, mg); log('  ->', a.status, a.ms + 'ms', kes(a.json?.details?.files?.map(f => [f.name, f.length]) ?? a.metin, 300))
      await sleep(2500); const sa = (await stats(d, a.json.id)).json; log('  indirme basladi mi: state', sa.state, 'progress', mb(sa.progress_bytes))
      // 6b ayni infohash tekrar (bytes ile ve magnet ile)
      const b1 = await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: kok('baska') }), fs.readFileSync(T.buyuk)); log('6b ayni infohash .torrent ile ->', b1.status, 'id', b1.json?.id, 'output_folder', b1.json?.output_folder, kes(b1.metin, 160))
      const b2 = await http(d, 'POST', '/torrents', mg); log('   ayni infohash magnet ile ->', b2.status, 'id', b2.json?.id, kes(b2.metin, 160))
      log('   liste uzunlugu', (await http(d, 'GET', '/torrents')).json.torrents.length)
      // 6c list_only
      const c = await http(d, 'POST', '/torrents?' + q({ list_only: 'true' }), fs.readFileSync(T.paket)); log('6c list_only=true ->', c.status, kes(c.json, 420))
      log('   list_only sonrasi liste uzunlugu', (await http(d, 'GET', '/torrents')).json.torrents.length)
      const c2 = await http(d, 'POST', '/torrents?' + q({ list_only: 'true', initial_peers: peer }), 'magnet:?xt=urn:btih:' + IH.paket); log('   list_only magnet+peer ->', c2.status, c2.ms + 'ms', kes(c2.json?.details?.files?.map(f => f.name) ?? c2.json ?? c2.metin, 200))
      // 6d paused ekleme
      const dp = await http(d, 'POST', '/torrents?' + q({ paused: 'true', initial_peers: peer, output_folder: kok('paused') }), fs.readFileSync(T.paket)); log('6d paused=true ->', dp.status, 'id', dp.json?.id)
      await sleep(2000); const sp = (await stats(d, dp.json.id)).json; log('   state', sp.state, 'progress', mb(sp.progress_bytes), 'diskte', fs.existsSync(kok('paused')) ? fs.readdirSync(kok('paused')).length + ' oge' : 'klasor yok')
      const st = await http(d, 'POST', '/torrents/' + dp.json.id + '/start'); await sleep(2500); const sp2 = (await stats(d, dp.json.id)).json; log('   start sonrasi', st.status, 'state', sp2.state, 'progress', mb(sp2.progress_bytes))
      // 6e klasor: output_folder ve sub_folder
      await http(d, 'POST', '/torrents/' + IH.paket + '/forget')
      const e2 = await http(d, 'POST', '/torrents?' + q({ sub_folder: 'altklasor', initial_peers: peer, overwrite: 'true' }), fs.readFileSync(T.paket)); log('6e sub_folder=altklasor ->', e2.status, 'output_folder', e2.json?.output_folder ?? e2.metin.slice(0, 200))
      await http(d, 'POST', '/torrents/' + IH.paket + '/forget')
      const e4 = await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, overwrite: 'true' }), fs.readFileSync(T.paket)); log('   hicbiri verilmez (sunucu varsayilani) ->', e4.status, 'output_folder', e4.json?.output_folder)
      // 6f gecersiz girdiler
      const g1 = await http(d, 'POST', '/torrents', 'bu bir torrent degil'); log('6f gecersiz govde ->', g1.status, kes(g1.metin, 160))
      const g3 = await http(d, 'POST', '/torrents?' + q({ list_only: 'true' }), T.paket); log('   govde=yerel dosya yolu (.torrent) ->', g3.status, kes(g3.metin, 160))
    } finally { oldur(d); oldur(seed) }
  },

  async 7() {
    sil(path.join(DIZIN, 'dl7')); const d = indirici('dl7', { api: 3052, port: 4252 })
    try {
      await hazirBekle(d)
      const yok = '0123456789abcdef0123456789abcdef01234567'
      const mg = 'magnet:?xt=urn:btih:' + yok + '&dn=yok'
      // 7a: istemci tarafi AbortController
      const ac = new AbortController(); const t0 = performance.now(); setTimeout(() => ac.abort(), 5000)
      const p = http(d, 'POST', '/torrents?' + q({ initial_peers: '127.0.0.1:4299', output_folder: path.join(DIZIN, 'dl7', 'cikti') }), mg, { signal: ac.signal }).then(r => ['bitti', r.status, r.metin], e => ['iptal', e.name])
      await sleep(2000)
      const kontrolSure = await http(d, 'GET', '/torrents'); log('7a bekleyen POST sirasinda API yanit veriyor mu: GET /torrents ->', kontrolSure.status, kes(kontrolSure.json), kontrolSure.ms + 'ms')
      log('   POST sonucu (5 sn iptal):', await p, Math.round(performance.now() - t0) + 'ms')
      await sleep(1000)
      const l = await http(d, 'GET', '/torrents'); log('   iptal sonrasi /torrents:', kes(l.json), '| stats:', (await http(d, 'GET', '/torrents/' + yok + '/stats/v1')).metin.slice(0, 160))
      const gs = (await http(d, 'GET', '/stats')).json; log('   global peers', kes(gs.peers), 'oturum klasoru:', fs.readdirSync(path.join(DIZIN, 'dl7', 'oturum')))
      // 7b: iptal sonrasi add_peers
      const ap = await http(d, 'POST', '/torrents/' + yok + '/add_peers', '127.0.0.1:4251\n'); log('7b iptal sonrasi add_peers ->', ap.status, ap.metin.slice(0, 150))
      // 7c: list_only + magnet yok
      const ac2 = new AbortController(); setTimeout(() => ac2.abort(), 4000)
      const r2 = await http(d, 'POST', '/torrents?' + q({ list_only: 'true', initial_peers: '127.0.0.1:4299' }), mg, { signal: ac2.signal }).then(r => ['bitti', r.status, r.metin.slice(0, 150)], e => ['iptal', e.name]); log('7c list_only magnet yok (4 sn iptal) ->', r2, '| liste', kes((await http(d, 'GET', '/torrents')).json))
      // 7d: resolve_magnet
      const ac3 = new AbortController(); setTimeout(() => ac3.abort(), 4000)
      const r3 = await http(d, 'POST', '/torrents/resolve_magnet', mg, { signal: ac3.signal }).then(r => ['bitti', r.status, r.metin.slice(0, 150)], e => ['iptal', e.name]); log('7d resolve_magnet yok (4 sn iptal) ->', r3)
      // 7e: sunucu tarafi zaman asimi var mi? 40 sn bekle
      const t1 = performance.now(); const ac4 = new AbortController(); setTimeout(() => ac4.abort(), 40000)
      const r4 = await http(d, 'POST', '/torrents?' + q({ initial_peers: '127.0.0.1:4299', output_folder: path.join(DIZIN, 'dl7', 'cikti2') }), 'magnet:?xt=urn:btih:' + 'abcdef0123456789abcdef0123456789abcdef01', { signal: ac4.signal }).then(r => ['bitti', r.status, r.metin.slice(0, 200)], e => ['iptal', e.name]); log('7e 40 sn bekleme ->', r4, Math.round(performance.now() - t1) + 'ms', '| liste', kes((await http(d, 'GET', '/torrents')).json))
      // 7f: sessiz peer (baglanir ama metadata gondermez): DHT'li gercek durumun en yakin yerel taklidi
      const net = await import('node:net'); const sessiz = net.createServer(sk => { sk.on('data', () => {}); sk.on('error', () => {}) }).listen(4298, '127.0.0.1')
      const ac5 = new AbortController(); const t2 = performance.now(); setTimeout(() => ac5.abort(), 4000)
      const r5 = await http(d, 'POST', '/torrents?' + q({ initial_peers: '127.0.0.1:4298', output_folder: path.join(DIZIN, 'dl7', 'cikti3') }), 'magnet:?xt=urn:btih:' + 'aaaaaa0123456789abcdef0123456789abcdef01', { signal: ac5.signal }).then(r => ['bitti', r.status, r.metin.slice(0, 160)], e => ['iptal', e.name])
      log('7f sessiz peer, istemci 4 sn sonra iptal ->', r5, Math.round(performance.now() - t2) + 'ms')
      for (const bek of [1, 8, 15]) { await sleep(bek * 1000); const li = (await http(d, 'GET', '/torrents')).json; const gp = (await http(d, 'GET', '/stats')).json.peers; log('   iptalden +' + bek + ' sn: liste', kes(li), 'peers', kes(gp, 160)) }
      const t3 = performance.now()
      const r6 = await http(d, 'POST', '/torrents?' + q({ initial_peers: '127.0.0.1:4298', peer_read_write_timeout: '2s', peer_connect_timeout: '1s', output_folder: path.join(DIZIN, 'dl7', 'cikti4') }), 'magnet:?xt=urn:btih:' + 'bbbbbb0123456789abcdef0123456789abcdef01')
      log('7g sessiz peer + peer_read_write_timeout=2s (iptal yok) ->', r6.status, r6.metin.slice(0, 160), Math.round(performance.now() - t3) + 'ms')
      const t4 = performance.now(); const r7 = await http(d, 'POST', '/torrents?' + q({ initial_peers: '127.0.0.1:4298', output_folder: path.join(DIZIN, 'dl7', 'cikti5') }), 'magnet:?xt=urn:btih:' + 'cccccc0123456789abcdef0123456789abcdef01')
      log('7h sessiz peer, varsayilan zaman asimlari, iptal yok ->', r7.status, r7.metin.slice(0, 160), Math.round(performance.now() - t4) + 'ms')
      sessiz.close()
      log('   diskte kalan:', fs.existsSync(path.join(DIZIN, 'dl7', 'cikti')) ? fs.readdirSync(path.join(DIZIN, 'dl7', 'cikti')) : 'klasor yok')
    } finally { oldur(d) }
  },

  async 8() {
    const seed = await tohumla(); sil(path.join(DIZIN, 'dl8'), ...[1, 2, 3, 4, 5].map(i => path.join(DIZIN, 'dl8-L' + i)))
    const yol8 = path.join(DIZIN, 'dl8', 'cikti')
    let d = indirici('dl8', { api: 3053, port: 4253, hiz: 0 })
    const L = []
    // Yerel "yalniz dl8'e baglanan" bir leecher: 6 sn icinde ne kadar aldi
    const leech = async (i, ms = 6000) => {
      const l = indirici('dl8-L' + i, { api: 3060 + i, port: 4260 + i, hiz: 0, oturum: false }); L.push(l); await hazirBekle(l)
      const r = await http(l, 'POST', '/torrents?' + q({ initial_peers: '127.0.0.1:4253' }), fs.readFileSync(T.paket))
      await sleep(ms); const s = (await stats(l, r.json.id)).json
      const u = (await http(d, 'GET', '/torrents/' + IH.paket + '/stats/v1')).json
      oldur(l); return { leech_progress: mb(s.progress_bytes), leech_finished: s.finished, leech_peer: s.live?.snapshot?.peer_stats?.live, dl8_uploaded: mb(u?.uploaded_bytes ?? 0), dl8_state: u?.state }
    }
    try {
      await hazirBekle(d)
      const r = await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: yol8 }), fs.readFileSync(T.paket)); const id = r.json.id
      const t0 = performance.now(); let st
      for (;;) { st = (await stats(d, id)).json; if (st.finished) break; await sleep(300) }
      log('8a tamamlandi:', Math.round(performance.now() - t0), 'ms (sinirsiz yerel hiz), state', st.state, 'finished', st.finished, 'progress', mb(st.progress_bytes), '/', mb(st.total_bytes), 'tam stats:', kes(st, 700))
      const fsu = (await import('node:child_process')).execFileSync
      const crypto = await import('node:crypto')
      const h = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')
      for (const f of fs.readdirSync(yol8)) { const a = path.join(yol8, f); const b = path.join(KAYNAK, 'Show.S01', f); log('   dosya', f, mb(fs.statSync(a).size), 'kaynakla ayni:', h(a) === h(b), '|', fsu('fsutil', ['sparse', 'queryflag', a]).toString().trim()) }
      log('   klasor yapisi:', fs.readdirSync(yol8), 'oturum klasoru:', fs.readdirSync(path.join(DIZIN, 'dl8', 'oturum')))
      oldur(seed); await sleep(500)
      log('8b tamamlandiktan sonra yukleme (varsayilan):', JSON.stringify(await leech(1)))
      const p = await http(d, 'POST', '/torrents/' + id + '/pause'); log('8c pause ->', p.status, JSON.stringify(await leech(2)), '| dl8 state', (await stats(d, id)).json.state)
      log('   duraklatilmis TAMAMLANMIS torrent stats:', JSON.stringify((await stats(d, id)).json))
      const sr = await http(d, 'POST', '/torrents/' + id + '/start'); log('   start ->', sr.status, '(yeniden dogrulama yapti mi?) state', (await stats(d, id)).json.state)
      // yukleme siniri: yeniden baslat
      for (const lim of ['1']) {
        oldur(d); await sleep(800); d = indirici('dl8', { api: 3053, port: 4253, hiz: 0, up: lim, temiz: false }); await hazirBekle(d)
        for (let i = 0; i < 100; i++) { const x = (await stats(d, id)).json; if (x?.state === 'live') break; await sleep(100) }
        log('8d --ratelimit-upload ' + lim + ' ->', JSON.stringify(await leech(4, 8000)))
      }
      oldur(d); await sleep(800); d = indirici('dl8', { api: 3053, port: 4253, hiz: 0, temiz: false }); await hazirBekle(d)
      for (let i = 0; i < 100; i++) { const x = (await stats(d, id)).json; if (x?.state === 'live') break; await sleep(100) }
      const f = await http(d, 'POST', '/torrents/' + id + '/forget'); log('8e forget ->', f.status, JSON.stringify(await leech(5)), '| dosyalar duruyor mu:', fs.readdirSync(yol8).length, 'dosya')
    } finally { oldur(d); L.forEach(oldur); oldur(seed) }
  },

  async 9() {
    const seed = await tohumla(); sil(path.join(DIZIN, 'dl9')); const d = indirici('dl9', { api: 3052, port: 4252 })
    try {
      await hazirBekle(d)
      const r = await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: path.join(DIZIN, 'dl9', 'cikti') }), fs.readFileSync(T.buyuk)); const id = r.json.id
      await sleep(3000)
      // 9a: calisma zamani limit ucu araniyor
      const denemeler = [['GET', '/ratelimits'], ['POST', '/ratelimits'], ['GET', '/limits'], ['POST', '/limits'], ['POST', '/session/limits'], ['POST', '/torrents/' + id + '/ratelimit'], ['POST', '/torrents/' + id + '/limits'], ['POST', '/settings'], ['GET', '/settings'], ['POST', '/ratelimit_download'], ['POST', '/set_limits'], ['PUT', '/limits']]
      for (const [m, y] of denemeler) { const x = await http(d, m, y, m === 'GET' ? undefined : JSON.stringify({ download_bps: 1048576, upload_bps: 0 }), { headers: { 'content-type': 'application/json' } }); log('9a', m, y, '->', x.status, x.metin.slice(0, 80)) }
      const ap = (await http(d, 'GET', '/')).json.apis; log('   API listesindeki limit/ratelimit anahtarlari:', Object.keys(ap).filter(k => /limit|rate|speed/i.test(k + ap[k])))
      // 9b: stats alanlari
      const s1 = (await stats(d, id)).json; log('9b calisirken stats/v1:', JSON.stringify(s1))
      log('   GET /stats (global):', (await http(d, 'GET', '/stats')).metin.slice(0, 400))
      const pst = await http(d, 'GET', '/torrents/' + id + '/peer_stats'); log('   GET peer_stats:', pst.status, pst.metin.slice(0, 300))
      // 9c: tamamlanmis ETA/hiz alanlari, tamamlanan torrent
      const paketId = (await http(d, 'POST', '/torrents?' + q({ initial_peers: peer, output_folder: path.join(DIZIN, 'dl9', 'paket'), only_files: '1' }), fs.readFileSync(T.paket))).json.id
      await sleep(1500); log('9c tamamlanan (yalniz srt secili) stats:', JSON.stringify((await stats(d, paketId)).json).slice(0, 700))
      // 9d: hata durumu uret: oldur, dosyanin yerine klasor koy, yeniden baslat
      oldur(d); await sleep(800)
      const hedef = path.join(DIZIN, 'dl9', 'cikti', 'Buyuk.Film.2160p.mkv'); fs.rmSync(hedef); fs.mkdirSync(hedef)
      const d2 = indirici('dl9', { api: 3052, port: 4252, temiz: false }); await hazirBekle(d2); await sleep(2500)
      const e = (await stats(d2, id)); log('9d hata durumu: HTTP', e.status, 'stats:', e.metin.slice(0, 500))
      oldur(d2)
    } finally { oldur(d); oldur(seed) }
  },
}

const istenen = process.argv.slice(2)
for (const k of istenen) { log(`\n===== KONTROL ${k} =====`); try { await kontroller[k]() } catch (e) { log('HATA', e) } }
hepsiniDurdur(); process.exit(0)
