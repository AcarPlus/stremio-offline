// Ayarlar: config.json + ortam değişkenleri.
// Sınama için OFFLINE_DATA_DIR verilirse kök klasördeki config.json hiç okunmaz/yazılmaz ve
// indirme klasörü (OFFLINE_DOWNLOAD_DIR yoksa) veri klasörünün altına alınır; böylece
// kullanıcının gerçek verisine ve indirme klasörüne yanlışlıkla dokunulmaz.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULTS = {
  port: 11480,
  downloadDir: path.join(os.homedir(), 'Videos', 'Stremio-Offline'),
  // Torrentio'yu ayarlı kullanıyorsan buraya kendi adresini yaz
  // (ör. https://torrentio.strem.fun/qualityfilter=480p) — sonunda /manifest.json olmadan.
  torrentioUrl: 'https://torrentio.strem.fun',
  // Akış listesinde her Torrentio sonucu için "İndir+Oynat" satırı gösterilsin mi?
  showDownloadRows: true,
  // Kart menüsündeki "Cihaza indir" hangi sürümü seçsin: bu kalite, bu boyutun altı, en çok kaynaklı olan.
  autoQuality: '1080p',
  autoMaxSizeGB: 12,
  // Stremio arayüzüne düğme eklemek için kullanılan hata ayıklama kapısı (Stremio başlatıcıyla açılmalı).
  debugPort: 11481,
  // rqbit motoru: yalnızca 127.0.0.1'de dinleyen API kapısı ve eşler için dinleme kapısı.
  rqbitApiPort: 11482,
  rqbitPeerPort: 4240,
  // Eş bağlantılarını dinleyen adres. 127.0.0.1: yalnızca giden bağlantı (güvenlik duvarı sorusu çıkmaz).
  peerListenIp: '127.0.0.1',
  // Torrent bilgisi (metadata) bu kadar saniyede gelmezse ekleme hata ile sonuçlanır.
  metadataTimeoutSec: 90,
  // Yeni indirmeler için varsayılan indirme sınırı, bayt/sn; 0 = sınırsız. İndirme Merkezi'nden
  // değiştirilince data/ayarlar.json'daki değer geçerli olur (bu satır yalnızca ilk değerdir).
  downloadLimit: 0,
  // Yükleme sınırı, bayt/sn, her motor süreci için (0 = sınırsız). İlk değer; sonrası data/ayarlar.json.
  uploadLimit: 100000,
  // Öncelikli indirme varken diğer etkin indirmelerin kısıldığı hız, bayt/sn (ilk değer; sonrası data/ayarlar.json).
  priorityThrottle: 200000,
  // İndirme başına motor süreçlerinin kapıları: API engineApiPortBase+k, eş enginePeerPortBase+k (k < engineSlots).
  engineApiPortBase: 11490,
  enginePeerPortBase: 4241,
  engineSlots: 100
}

const env = process.env
const num = v => (v === undefined || v === '' ? undefined : Number(v))

export function loadConfig () {
  const testMode = !!env.OFFLINE_DATA_DIR
  const dataDir = testMode ? path.resolve(env.OFFLINE_DATA_DIR) : path.join(ROOT, 'data')
  const configFile = testMode ? path.join(dataDir, 'config.json') : path.join(ROOT, 'config.json')
  let fileCfg = {}
  try { fileCfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch {}
  const cfg = { ...DEFAULTS, ...(testMode ? { downloadDir: path.join(dataDir, 'indirilenler') } : {}), ...fileCfg }
  // Gerçek kurulumda eksik anahtarları dosyaya ekle (kullanıcı görsün/değiştirsin).
  if (!testMode && Object.keys(DEFAULTS).some(k => !(k in fileCfg))) {
    try { fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2)) } catch {}
  }
  const over = {
    port: num(env.OFFLINE_PORT),
    downloadDir: env.OFFLINE_DOWNLOAD_DIR ? path.resolve(env.OFFLINE_DOWNLOAD_DIR) : undefined,
    rqbitApiPort: num(env.OFFLINE_RQBIT_PORT),
    rqbitPeerPort: num(env.OFFLINE_PEER_PORT),
    torrentioUrl: env.OFFLINE_TORRENTIO_URL || undefined,
    metadataTimeoutSec: num(env.OFFLINE_METADATA_TIMEOUT),
    downloadLimit: num(env.OFFLINE_RATELIMIT_DOWN),
    uploadLimit: num(env.OFFLINE_RATELIMIT_UP),
    engineApiPortBase: num(env.OFFLINE_ENGINE_API_BASE),
    enginePeerPortBase: num(env.OFFLINE_ENGINE_PEER_BASE),
    engineSlots: num(env.OFFLINE_ENGINE_SLOTS),
    playGraceMs: num(env.OFFLINE_PLAY_GRACE_MS), // son akış bağlantısı kapandıktan sonra oynatma muafiyeti (varsayılan 30000)
    peerListenIp: env.OFFLINE_PEER_LISTEN_IP === undefined ? undefined : (env.OFFLINE_PEER_LISTEN_IP || null)
  }
  for (const [k, v] of Object.entries(over)) if (v !== undefined) cfg[k] = v
  // Yalnızca sınama: internetsiz döngü (DHT/tracker/LSD kapalı) ve her eklemede verilecek eşler.
  cfg.loopback = env.OFFLINE_LOOPBACK === '1'
  cfg.extraPeers = (env.OFFLINE_EXTRA_PEERS || '').split(',').map(s => s.trim()).filter(Boolean)
  cfg.inject = env.OFFLINE_NO_INJECT !== '1'
  cfg.pollMs = num(env.OFFLINE_POLL_MS) || 1000
  cfg.root = ROOT
  cfg.testMode = testMode
  cfg.dataDir = dataDir
  cfg.rqbitDir = path.join(dataDir, 'rqbit')
  cfg.torrentDir = path.join(dataDir, 'torrents')
  cfg.libFile = path.join(dataDir, 'library.json')
  cfg.imgDir = path.join(dataDir, 'img')
  cfg.metaDir = path.join(dataDir, 'meta')
  cfg.base = `http://127.0.0.1:${cfg.port}`
  // İzinli Host başlıkları (DNS yeniden bağlamaya karşı). Sonraki faz bir LAN adresi ekleyecekse
  // yalnızca burayı genişletmek yeter (cfg.extraHosts ya da OFFLINE_EXTRA_HOSTS, "adres:port" listesi).
  cfg.allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`,
    ...(env.OFFLINE_EXTRA_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)])
  cfg.rqbitExe = env.OFFLINE_RQBIT_EXE || path.join(ROOT, 'bin', 'rqbit.exe')
  for (const d of [dataDir, cfg.rqbitDir, cfg.torrentDir, cfg.imgDir, cfg.metaDir, cfg.downloadDir]) fs.mkdirSync(d, { recursive: true })
  return cfg
}
