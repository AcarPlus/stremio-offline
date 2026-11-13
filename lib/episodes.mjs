// Dosya adlarından sezon/bölüm çıkarımı (paket içindeki dosyaları bölümlere eşlemek için).

const PATTERNS = [
  /\bS(\d{1,2})[ ._-]?E(\d{1,3})(?:[ ._-]?E\d{1,3})*\b/i, // S01E02, S01.E02, S01E02E03
  /\b(\d{1,2})x(\d{2,3})\b/i, // 1x02
  /\bSeason[ ._-]?(\d{1,2})[ ._-]+Episode[ ._-]?(\d{1,3})\b/i
]

/** Tek bir ad parçasından { season, episode } ya da null. */
export function parseEpisode (name) {
  const s = String(name || '')
  for (const re of PATTERNS) {
    const m = re.exec(s)
    if (m) {
      const season = +m[1]
      const episode = +m[2]
      // 1080x720 gibi çözünürlükleri ve yılları bölüm sanma
      if (re === PATTERNS[1] && (season > 30 || episode > 400)) continue
      return { season, episode }
    }
  }
  return null
}

/** Klasör adlarından sezon (ör. "Season 2", "S02") */
export function parseSeason (name) {
  const m = /\b(?:S|Season[ ._-]?)(\d{1,2})\b/i.exec(String(name || ''))
  return m ? +m[1] : null
}

/**
 * Paketteki dosyaları bölümlere eşler. files: [{ idx, name, components, length }]
 * Dönen: Map(idx -> { season, episode }). Yalnızca video dosyaları ve örnek (sample) olmayanlar.
 */
export function mapPackFiles (files, { videoExt = /\.(mkv|mp4|avi|mov|m4v|webm|ts|wmv|mpg|mpeg|flv)$/i, torrentName = '' } = {}) {
  const out = new Map()
  for (const f of files) {
    const comps = f.components || [f.name]
    const base = comps[comps.length - 1]
    if (!videoExt.test(base) || /\bsample\b/i.test(comps.join('/'))) continue
    let ep = parseEpisode(base)
    if (!ep) {
      // "Episode 02.mkv", "E02.mkv", "02 - Başlık.mkv" + klasör/paket adından sezon
      const m = /(?:\bE|Episode[ ._-]?|^)(\d{1,3})\b/i.exec(base)
      const season = [...comps.slice(0, -1)].reverse().map(parseSeason).find(x => x != null) ?? parseSeason(torrentName)
      if (m && season != null) ep = { season, episode: +m[1] }
    }
    if (ep) out.set(f.idx, ep)
  }
  return out
}
