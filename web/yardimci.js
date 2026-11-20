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

  g.OfflineYardimci = { qualityGroup, qualityRank, qualityLabel, compareQuality, errorText, deleteText, pickOption, qualityGroups }
})(typeof globalThis !== 'undefined' ? globalThis : this)
