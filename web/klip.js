// İndirme Merkezi: sürüm seçicide "Klip" (indirmeden önce 60 sn'lik örnek; API: docs/api.md "Klip").
// app.js'ten ÖNCE yüklenir; app.js'in genel yardımcılarını (h, fmtBytes, toast, onayla, oynat, absUrl, EMBED)
// yalnız çağrı anında kullanır. Satır yeniden çizilse de iş, kaynak anahtarıyla (infoHash:fileIdx) izlenmeye devam eder.
'use strict'

const KLIP_ISLER = new Map() // anahtar -> son iş görünümü
let klipYetenekP = null

function klipYetenek (yenile) {
  if (!klipYetenekP || yenile) {
    klipYetenekP = fetch('/api/klip').then(r => r.json()).catch(() => ({ available: false, reason: 'Servise ulaşılamıyor' }))
  }
  return klipYetenekP
}

async function klipIstek (method, url, body) {
  let r
  try { r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }) } catch { throw new Error('Servise ulaşılamıyor') }
  let j = null
  try { j = await r.json() } catch {}
  if (!r.ok) throw Object.assign(new Error((j && j.err) || `Sunucu hatası (${r.status})`), { status: r.status, body: j })
  return j
}

const klipAnahtar = v => v.infoHash + ':' + (v.fileIdx ?? 'x')
const KLIP_SON = new Set(['ready', 'error', 'canceled'])

/** Saniye -> "s:dd:ss" ya da "d:ss". */
function klipSaat (s) {
  s = Math.max(0, Math.floor(s))
  const p = n => String(n).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`
}

/** Klip iş metni (saf): durum + ilerleme. */
function klipMetni (j) {
  const mb = j.downloadedBytes ? fmtBytes(j.downloadedBytes) : '0 MB'
  const es = j.peers ? ` · ${j.peers} eş` : ''
  switch (j.state) {
    case 'connecting': return 'Kaynağa bağlanılıyor…'
    case 'downloading': return `Bağlandı, okunuyor: ${mb}${es}`
    case 'preparing': return `Klip hazırlanıyor: ${j.doneSec || 0}/${j.lengthSec || 60} sn` + (j.source === 'torrent' ? ` · ${mb} indirildi${es}` : '')
    case 'ready': return `✔ Klip hazır: ${j.lengthSec || 60} sn, ${fmtBytes(j.sizeBytes)}` + (j.startSec != null && j.durationSec ? ` (${klipSaat(j.startSec)} – ${klipSaat(j.startSec + (j.lengthSec || 60))} arası)` : '')
    case 'error': return '✖ ' + (j.error || 'Klip alınamadı')
    case 'canceled': return 'Klip iptal edildi'
    default: return j.message || ''
  }
}

/**
 * Sürüm satırı için "Klip" düğmesi ve durum alanı. v: sürüm; ctx: { type, id, current }.
 * Dönüş: [düğme, durum] (ikisi de satırın işlem hücresine eklenir).
 */
function klipDugmesi (v, ctx) {
  const key = klipAnahtar(v)
  const durum = h('div', { class: 'klipDurum', hidden: true })
  const b = h('button', { class: 'dugme gri kucuk', type: 'button', title: 'İndirmeden önce 60 sn’lik örnek al: kalite birebir (yeniden sıkıştırma yok), kütüphaneye eklenmez' }, '🎬 Klip')
  let timer = null
  klipYetenek().then(c => {
    if (!c.available) { b.disabled = true; b.title = 'Klip kullanılamıyor: ' + (c.reason || 'ffmpeg bulunamadı'); return }
    if (c.job && klipAnahtar(c.job) === key) KLIP_ISLER.set(key, c.job)
    const hazir = (c.klips || []).find(x => klipAnahtar(x) === key)
    if (hazir && !KLIP_ISLER.has(key)) KLIP_ISLER.set(key, hazir)
    const j = KLIP_ISLER.get(key)
    if (j) { goster(j); if (!KLIP_SON.has(j.state)) izle(j.id) }
  })
  b.addEventListener('click', () => baslat(false))

  async function baslat (replace) {
    b.disabled = true
    try {
      const r = await klipIstek('POST', '/api/klip', {
        infoHash: v.infoHash, fileIdx: v.fileIdx ?? null, trackers: v.trackers || [], type: ctx.type, id: ctx.id,
        title: v.name || v.title || '', fileName: v.fileName || '', replace
      })
      KLIP_ISLER.set(key, r.job)
      goster(r.job)
      if (!KLIP_SON.has(r.job.state)) izle(r.job.id)
    } catch (e) {
      b.disabled = false
      if (e.status === 409 && !replace) {
        const o = await onayla({ baslik: 'Başka bir klip hazırlanıyor', metin: `Aynı anda tek klip hazırlanır${e.body && e.body.job && e.body.job.title ? ' (şu an: “' + e.body.job.title + '”)' : ''}. Onu iptal edip bu sürümün klibini başlatayım mı?`, tamam: 'İptal et ve başlat' })
        if (o.ok) baslat(true)
        return
      }
      toast('Klip başlatılamadı: ' + e.message, 'hata')
    }
  }

  function izle (jobId) {
    clearInterval(timer)
    timer = setInterval(async () => {
      if (!durum.isConnected || (ctx.current && !ctx.current())) { clearInterval(timer); return }
      try {
        const j = await klipIstek('GET', '/api/klip/' + jobId)
        KLIP_ISLER.set(key, j)
        goster(j)
        if (KLIP_SON.has(j.state)) clearInterval(timer)
      } catch (e) {
        clearInterval(timer)
        if (e.status === 404) { KLIP_ISLER.delete(key); goster(null) }
      }
    }, 1000)
  }

  function goster (j) {
    if (!j) { durum.hidden = true; durum.replaceChildren(); b.disabled = false; return }
    const calisiyor = !KLIP_SON.has(j.state)
    b.disabled = calisiyor
    durum.hidden = false
    durum.classList.toggle('hata', j.state === 'error')
    const kids = [h('span', null, klipMetni(j)), ' ']
    if (calisiyor) {
      kids.push(h('button', { class: 'dugme gri kucuk', type: 'button', onclick: async () => { try { await klipIstek('DELETE', '/api/klip/' + j.id) } catch (e) { toast(e.message, 'hata') } } }, 'İptal'))
    } else if (j.state === 'ready') {
      const desc = { id: j.id, infoHash: j.infoHash, type: null, imdbId: null, videoId: null, season: null, episode: null, fileIdx: null, fileName: 'klip.mkv', title: 'Klip: ' + (j.title || v.name || ''), name: v.name, state: 'ready', poster: '', playUrl: absUrl(j.fileUrl) }
      if (EMBED) kids.push(h('button', { class: 'dugme oynat kucuk', type: 'button', onclick: () => oynat(desc) }, '▶ Klibi oynat'))
      else {
        // Tarayıcıda (gömülü değil): <video> ile dene (MKV her tarayıcıda oynamayabilir), yanında dosya bağlantısı
        kids.push(h('button', { class: 'dugme oynat kucuk', type: 'button', onclick: () => { if (!durum.querySelector('video')) durum.append(h('video', { src: desc.playUrl, controls: true, autoplay: true })) } }, '▶ Klibi oynat'), ' ',
          h('a', { href: desc.playUrl, target: '_blank', rel: 'noopener', class: 'dugme gri kucuk' }, 'Dosyayı aç'))
      }
      kids.push(' ', h('button', { class: 'dugme gri kucuk', type: 'button', title: 'Klibi sil (24 saat sonra kendiliğinden silinir)', onclick: async () => { try { await klipIstek('DELETE', '/api/klip/' + j.id); KLIP_ISLER.delete(key); goster(null) } catch (e) { toast(e.message, 'hata') } } }, 'Sil'))
    } else {
      b.disabled = false
    }
    durum.replaceChildren(...kids)
  }

  return [b, durum]
}
