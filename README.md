# Stremio Offline

**Download what you watch in Stremio and play it later, with no internet connection.**

Stremio Offline is a free, open-source companion for **Stremio 5 on Windows**. It adds **Download**, **Download season** and **Downloads** right inside Stremio. Downloaded movies and episodes play in Stremio's own player, even when you're offline: on a plane, a train, or wherever the connection is poor.

> 🇹🇷 Türkçe kurulum rehberi aşağıda: [Türkçe](#türkçe)
> The user interface is currently in Turkish. English UI is planned.

---

## Features

- **Download button on every movie page.** It opens a version picker: quality, size, seeders, language and source, with sorting and filters. Each row has a *Download* and a *Download + play* option.
- **Download season.** Pick a whole season pack or individual episodes. The episode count and total size are shown before anything starts.
- **Downloads center inside Stremio.** It shows progress, speed, time left and disk usage. You can pause, resume, cancel, delete and mark one download as ★ priority.
- **Offline playback in Stremio's own player.** Downloaded titles get a badge on their poster and an *Offline play* button on their page.
- **Preview clip.** Before downloading, grab a short sample of a version to check its picture quality. A bitrate badge helps you spot over-compressed releases.
- **Settings tab:**
  - download queue and per-download speed limits
  - a time window for downloading (for example, only at night)
  - a minimum free-disk-space guard
  - a Windows notification when a download finishes
  - automatic version selection and a Turkish audio/subtitle preference
  - shut down the PC when everything is done
  - delete watched downloads
  - start with Windows
- **Survives Stremio updates.** When Stremio updates itself and rewrites its shortcut, the background service quietly restores the integration within a few seconds.
- **Clean and reversible.** No administrator rights, no registry changes, no firewall prompts, no Windows services. Uninstalling puts everything back the way it was.

## How it works

```
┌──────────── Stremio 5 (Windows) ────────────┐
│  Movie page:  [▶ Play]  [⬇ Download]        │  ← buttons injected into Stremio's UI
│  Sidebar:     Downloads                     │
└───────────────┬─────────────────────────────┘
                │ local only (127.0.0.1)
┌───────────────▼─────────────────────────────┐
│  Stremio Offline service (Node.js, :11480)  │
│   • Stremio addon (manifest, streams)       │
│   • Downloads center + REST API             │
│   • rqbit torrent engine (one process per   │
│     download, for per-download speed limits)│
└─────────────────────────────────────────────┘
```

- **Sources:** stream lists come from the public [Torrentio](https://torrentio.strem.fun) addon, the same results you already see in Stremio.
- **Engine:** [rqbit](https://github.com/ikatkov/rqbit), a fast BitTorrent client written in Rust. Uploading stops once a download finishes.
- **Integration:** Stremio 5's shell is built on WebView2. Stremio Offline starts it with a debugging port that only accepts local connections. Through that port it adds the buttons and the Downloads center to the page. It doesn't patch or modify any Stremio files.
- **Launching Stremio:** the installer rewires your own `Stremio` shortcuts (desktop, Start menu and the pinned taskbar icon) to a small launcher. It backs up the original shortcuts first. You keep opening Stremio exactly as before, from the same icon, and the buttons are there.
- Everything runs on `127.0.0.1`. Nothing is exposed to your network, and no data is sent anywhere. The only outgoing requests are to Torrentio and to GitHub, to check for a new version.

## Install

**Requirements:** Windows 10 or 11, and [Stremio 5](https://www.stremio.com/downloads) installed and opened at least once.

1. Download **`StremioOffline.zip`** from the [latest release](https://github.com/AcarPlus/stremio-offline/releases/latest).
2. Extract it to a permanent folder, such as *Documents*.
3. Double-click **`KUR.cmd`** (*KUR* means *install*), the only file next to the `uygulama` (*app*) folder.
   - If Windows SmartScreen says *"Windows protected your PC"*, click **More info → Run anyway**. The package isn't code-signed yet.
4. Stremio opens with **Download** buttons and a **Downloads** section.

The package is self-contained. It includes a portable Node.js and rqbit, so there's nothing else to install. Downloads are saved to `Videos\Stremio-Offline`.

## Uninstall

Double-click **`uygulama\KALDIR.cmd`** (*KALDIR* means *uninstall*). The service stops and your Stremio shortcuts are restored. You can then delete the folder. Your downloaded videos stay in `Videos\Stremio-Offline` until you delete them yourself.

## Known limitations

- **Windows only**, and tested on Stremio 5.0.x. An Android version is planned.
- If Stremio is started some other way than its shortcuts (for example from a `stremio://` link while it's closed), it opens without the buttons. Your downloads are still there. Reopen Stremio from its icon and the launcher offers to restart it with the buttons.
- The integration depends on Stremio's page structure. If a future Stremio release changes it a lot, the buttons may move or disappear until an update. The script detects this and reports it instead of failing silently.
- The UI is Turkish for now.

## Development

```powershell
npm test                      # unit and integration tests (node --test)
node server.mjs               # run the service in the foreground
./paketle.ps1                 # build dist\StremioOffline.zip
```

Design notes and the API reference are in [`docs/`](docs/), mostly in Turkish ([`docs/tasarim.md`](docs/tasarim.md) and [`docs/api.md`](docs/api.md)).

## Disclaimer

Stremio Offline is an independent project. It is not affiliated with or endorsed by Stremio or Torrentio. It hosts no content and doesn't provide any. You're responsible for what you download, and for respecting copyright law in your country.

## License

[MIT](LICENSE). Bundled third-party software: Node.js (MIT) and rqbit (Apache-2.0).

---

## Türkçe

**Stremio'da izlediğin filmleri ve dizileri bilgisayara indir, internet yokken de Stremio'nun içinden izle.**

Stremio Offline, **Windows'ta Stremio 5** için ücretsiz ve açık kaynak bir eklentidir. Stremio'nun içine **İndir** ve **Sezonu indir** düğmeleri ile **İndirilenler** bölümünü ekler.

### Kurulum

1. [Son sürüm](https://github.com/AcarPlus/stremio-offline/releases/latest) sayfasından **`StremioOffline.zip`** dosyasını indir.
2. Zip'i kalıcı bir klasöre aç (örneğin Belgeler). Klasörü sonra taşırsan `KUR.cmd`'yi yeniden çalıştır.
3. Klasörde `uygulama` klasörünün yanındaki tek dosya olan **`KUR.cmd`**'ye çift tıkla. *"Windows bilgisayarınızı korudu"* uyarısı çıkarsa **Ek bilgi → Yine de çalıştır** de.
4. Stremio açılır. Film sayfasında **İndir** düğmesi, sol menüde **İndirilenler** görünür.

Stremio'yu her zamanki gibi kendi simgesinden aç: masaüstü, Başlat menüsü ya da görev çubuğu. Düğmeler oradan açınca da gelir. Stremio kendini güncelleyince arka plandaki servis birkaç saniye içinde ayarı geri getirir.

İndirilen dosyalar `Videolar\Stremio-Offline` klasörüne kaydedilir.

### Kaldırma

**`uygulama\KALDIR.cmd`** dosyasına çift tıkla. Servis kapanır, Stremio kısayolları eski haline döner. İndirdiğin videolar silinmez.

### Neler yapabilir?

- Sürüm seçici: kalite, boyut, seeder, dil ve kaynak. İndirmeden önce **klip** ile görüntü kalitesine bakabilirsin.
- Sezonun tamamını ya da seçtiğin bölümleri indirebilirsin.
- İndirme Merkezi: duraklat, sürdür, sil, ★ öncelik ver, hız sınırı koy.
- İnmiş içeriğin posterinde rozet olur. Stremio oynatıcısında internetsiz izlersin.
- Ayarlar:
  - indirme kuyruğu
  - saat aralığı (örneğin yalnız gece indir)
  - disk alt sınırı
  - indirme bitince bildirim
  - Türkçe dublaj ve altyazı tercihi
  - hepsi bitince bilgisayarı kapat
  - izlenenleri sil
  - Windows ile başlat
