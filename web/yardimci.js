// İndirme Merkezi'nin saf yardımcıları (tarayıcıda ve Node sınamasında çalışır; DOM'a dokunmaz).
// app.js'ten önce yüklenir; `OfflineYardimci` genel adıyla kullanılır.
(function (g) {
  'use strict'

  const RANK = { '2160p': 5, '1080p': 4, '720p': 3, '480p': 2, düşük: 1 }

  /**
   * Torrentio'nun serbest kalite metnini (4k, 1080p, 720p, 480p, "1226p", scr, cam, boş…) birkaç
   * sabit gruba indirger: '2160p' | '1080p' | '720p' | '480p' | 'düşük' (CAM/ekran kaydı) | null (bilinmiyor).
   * Standart dışı yükseklikler en yakın gruba yuvarlanır (1226p → 1080p) ve ayrı bir süzgeç düğmesi olmaz.
   */
  function qualityGroup (q) {
    const t = String(q == null ? '' : q).trim()
    if (!t) return null
    if (/2160|\b4k\b|uhd/i.test(t)) return '2160p'
    const m = t.match(/(\d{3,4})\s*p/i)
    if (m) {
      const h = +m[1]
      if (h >= 1800) return '2160p'
      if (h >= 1000) return '1080p'
      if (h >= 600) return '720p'
      return '480p'
    }
    if (/\b(cam|scr|screener|telesync|\bts\b|hdcam)\b/i.test(t)) return 'düşük'
    return null
  }

  /** Sıralama sırası: bilinmeyen 0 (her yönde sona atılır). */
  const qualityRank = q => RANK[qualityGroup(q)] || 0

  /** Ekranda gösterilecek ad. */
  function qualityLabel (q) {
    const grp = qualityGroup(q)
    return grp === 'düşük' ? 'CAM/TS' : grp || 'Bilinmeyen'
  }

  /**
   * Kalite sütununa göre karşılaştırma: bilinmeyen kalite hem "yüksekten düşüğe" hem "düşükten
   * yükseğe" sıralamada en sonda kalır. dir: -1 yüksekten düşüğe, 1 düşükten yükseğe.
   */
  function compareQuality (a, b, dir) {
    const ra = qualityRank(a); const rb = qualityRank(b)
    if (!ra || !rb) return (ra ? 0 : 1) - (rb ? 0 : 1)
    return dir * (ra - rb)
  }

  /** Hata kartındaki açıklama: motor mesajı zaten "Sürdür" diyorsa ek yapılmaz. */
  function errorText (msg) {
    const t = String(msg || 'Bilinmeyen bir sorun oluştu.').trim()
    return 'Sorun: ' + t + (/sürdür/i.test(t) ? '' : ' “Sürdür” ile yeniden deneyebilirsin.')
  }

  /** Silme iletişiminin metni (D5): ne silinecek, kaç bayt, dosyaların akıbeti. */
  function deleteText (it, fmtBytes) {
    const ad = it.displayName || it.name
    const dosya = it.name && it.name !== ad ? ` Torrent: ${it.name}.` : ''
    const boyut = it.sizeBytes ? ` (${fmtBytes(it.sizeBytes)})` : ''
    return `“${ad}” kütüphaneden kaldırılır ve indirilen dosyalar diskten silinir${boyut}.${dosya} Dosyaları saklamak için aşağıdaki kutuyu işaretle; o zaman yalnızca kayıt kalkar.`
  }

  /**
   * Bölüm bölüm kipinde bir bölümün sürüm seçenekleri arasından varsayılanı seçer (E6): kalite GRUPLA
   * eşlenir (1226p → 1080p, 4k → 2160p), kaynağı olanlar öne alınır. q: 'auto' ya da bir kalite grubu.
   * Dizin döner, seçenek yoksa -1.
   */
  function pickOption (opts, q) {
    if (!opts.length) return -1
    const good = opts.map((o, i) => [o, i]).filter(([o]) => o.seeders > 0)
    const pool = good.length ? good : opts.map((o, i) => [o, i])
    const grp = o => qualityGroup(o.quality)
    if (q !== 'auto') { const m = pool.find(([o]) => grp(o) === q); if (m) return m[1] } else { const m = pool.find(([o]) => grp(o) === '1080p') || pool.find(([o]) => grp(o) === '720p'); if (m) return m[1] }
    return pool[0][1]
  }

  /** Seçeneklerdeki kalite grupları (yüksekten düşüğe, bilinmeyen = '?' sonda). */
  function qualityGroups (opts) {
    return [...new Set(opts.map(o => qualityGroup(o.quality) || '?'))].sort((a, b) => (a === '?') - (b === '?') || qualityRank(b) - qualityRank(a))
  }

  // ───────────── kalite rozeti (indirmeden tahmini bit hızı) ─────────────

  /**
   * Cinemeta "runtime" metni -> dakika (yoksa/anlaşılmazsa null). Biçimler: "2h 10min", "130 min", "1h",
   * "45min", "1 h 5 m", "2:10" (sa:dk), "PT2H10M" (ISO), çıplak sayı (dakika). "N/A" -> null.
   */
  function parseRuntime (s) {
    const t = String(s == null ? '' : s).trim().toLowerCase()
    if (!t) return null
    let m = /^pt(?:(\d+)h)?(?:(\d+)m)?/.exec(t)
    if (m && (m[1] || m[2])) return ok((+m[1] || 0) * 60 + (+m[2] || 0))
    m = /^(\d{1,2}):(\d{2})$/.exec(t)
    if (m) return ok(+m[1] * 60 + +m[2])
    if (/^\d+(?:[.,]\d+)?$/.test(t)) return ok(Math.round(parseFloat(t.replace(',', '.'))))
    const h = /(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours|sa|saat)\b/.exec(t)
    const mi = /(\d+)\s*(?:m|min|mins|minute|minutes|dk|dakika)\b/.exec(t)
    if (!h && !mi) return null
    return ok(Math.round((h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (mi ? +mi[1] : 0)))
    function ok (n) { return n > 0 && n < 1000 ? n : null }
  }

  /** Boyut (bayt) ve süre (dakika) -> ortalama bit hızı, Mbps (10^6 bit/sn). Eksik/anlamsızsa null. */
  function bitrateMbps (sizeBytes, minutes) {
    if (!(sizeBytes > 0) || !(minutes > 0)) return null
    return (sizeBytes * 8) / (minutes * 60) / 1e6
  }

  /**
   * Kalite grubuna göre bit hızı eşikleri (Mbps; ses dahil ortalama): [düşük üst sınır, iyi alt sınır].
   * H.264 için; HEVC/AV1 aynı görüntüyü ~%40 daha az bitle verdiği için eşikler 0,6 ile çarpılır.
   */
  const ESIK = { '2160p': [12, 25], '1080p': [4, 8], '720p': [2, 4], '480p': [1, 2] }
  const VERIMLI = 0.6

  /** Addan okunabilen teknik etiketler: { video: 'AV1'|'HEVC'|'AVC'|null, hdr: [...], bit10, audio: [...] } */
  function techInfo (text) {
    const t = ' ' + String(text == null ? '' : text).replace(/[._]/g, ' ') + ' '
    const video = /\bAV1\b/i.test(t) ? 'AV1' : /\b(x265|HEVC|H ?265)\b/i.test(t) ? 'HEVC' : /\b(x264|AVC|H ?264)\b/i.test(t) ? 'AVC' : null
    const hdr = []
    if (/\b(DV|DoVi|Dolby ?Vision)\b/i.test(t)) hdr.push('DV')
    if (/\bHDR10(\+|Plus)/i.test(t)) hdr.push('HDR10+')
    else if (/\bHDR(10)?\b/i.test(t)) hdr.push('HDR')
    const bit10 = /\b10 ?bit\b|\bHi10P?\b/i.test(t)
    const audio = []
    if (/\bAtmos\b/i.test(t)) audio.push('Atmos')
    if (/\bTrueHD\b/i.test(t)) audio.push('TrueHD')
    if (/\bDTS ?-? ?X\b/i.test(t)) audio.push('DTS:X')
    else if (/\bDTS ?-? ?HD( ?MA)?\b/i.test(t)) audio.push('DTS-HD')
    else if (/\bDTS\b/i.test(t)) audio.push('DTS')
    if (/\b(DDP|DD\+|E-?AC-?3)/i.test(t)) audio.push('DDP')
    else if (/\b(DD|AC-?3)( ?[257] ?[01])?\b/i.test(t) && !/\bDDP/i.test(t)) audio.push('DD')
    if (/\bAAC/i.test(t)) audio.push('AAC')
    if (/\bFLAC\b/i.test(t)) audio.push('FLAC')
    if (/\bOpus\b/i.test(t)) audio.push('Opus')
    return { video, hdr, bit10, audio }
  }

  /**
   * Sürüm satırının kalite rozeti. v: { sizeBytes, quality, kind, name, fileName }; minutes: süre (dk).
   * Dönüş: { mbps, level: 'dusuk'|'orta'|'iyi'|null, text, title } ya da süre/boyut güvenilmezse null.
   * Sezon paketlerinde (kind 'pack') bildirilen boyut tüm paketin olabileceğinden rozet verilmez;
   * 120 Mbps üstü (paket/koleksiyon boyutu sanılması) da gösterilmez.
   */
  function qualityBadge (v, minutes) {
    if (!v || v.kind === 'pack') return null
    const mbps = bitrateMbps(v.sizeBytes, minutes)
    if (mbps == null || mbps > 120) return null
    const grp = qualityGroup(v.quality)
    const info = techInfo((v.name || '') + ' ' + (v.fileName || ''))
    const esik = ESIK[grp]
    let level = null
    let title = `Tahmini ortalama bit hızı (boyut ÷ süre ${minutes} dk)`
    if (esik) {
      const k = info.video === 'HEVC' || info.video === 'AV1' ? VERIMLI : 1
      const [lo, hi] = esik.map(x => x * k)
      level = mbps < lo ? 'dusuk' : mbps > hi ? 'iyi' : 'orta'
      const f = x => (Math.round(x * 10) / 10).toLocaleString('tr-TR')
      title += `. ${grp}${k !== 1 ? ' ' + info.video : ''} için: ${f(lo)} altı düşük, ${f(lo)}–${f(hi)} orta, ${f(hi)} üstü iyi`
    }
    const text = (mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10).toLocaleString('tr-TR') + ' Mbps'
    return { mbps, level, text, title }
  }

  /** Satırda gösterilecek teknik etiketler (Torrentio'nun etiketleriyle tekrarsız birleşik). */
  function techTags (v) {
    const i = techInfo((v.name || '') + ' ' + (v.fileName || ''))
    const out = []
    const add = x => { if (x && !out.includes(x)) out.push(x) }
    add(i.video)
    for (const x of i.hdr) add(x)
    for (const x of v.tags || []) add(x === 'HDR' && out.includes('HDR10+') ? null : x)
    if (i.bit10) add('10bit')
    for (const x of i.audio) add(x)
    return out
  }

  g.OfflineYardimci = { qualityGroup, qualityRank, qualityLabel, compareQuality, errorText, deleteText, pickOption, qualityGroups, parseRuntime, bitrateMbps, techInfo, qualityBadge, techTags }
})(typeof globalThis !== 'undefined' ? globalThis : this)
