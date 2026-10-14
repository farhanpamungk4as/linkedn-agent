# linkedin-agent

Node.js 22 + TypeScript control center untuk outreach berbasis lead. SQLite adalah sumber data; dashboard adalah kontrol utama, Telegram adalah notifikasi dan kontrol cepat, Playwright adalah browser worker, dan Hermes bersifat opsional. Dirancang untuk satu instance aplikasi pada satu VPS.

## Arsitektur dan batas keamanan

| Komponen | Peran |
| --- | --- |
| `src/db`, `src/leads`, `src/templates`, `src/activity` | Migrasi SQLite, state machine, riwayat chat, template deterministik, audit trail |
| `src/browser`, `src/linkedin` | Worker mock atau Playwright CDP; selector LinkedIn terpisah dari workflow |
| `src/outreach`, `src/monitor` | Pending action, kirim setelah persetujuan, pemeriksaan balasan |
| `src/scheduler`, `src/system` | Job berkala, lock, pause, kill switch, riwayat job |
| `src/api`, `src/auth`, `web` | Dashboard, API terlindungi, session admin + CSRF |
| `src/telegram`, `src/hermes` | Bot/notifier dan adapter Hermes opsional |

Untuk deploy **tanpa domain memakai IP publik**, ikuti [panduan VPS dan webhook](deploy/README-ip.md). Telegram akan mengirim update langsung ke endpoint HTTPS VPS; aplikasi tidak menjalankan polling saat `TELEGRAM_MODE=webhook`.

Worker Playwright memakai `chromium.connectOverCDP(BROWSER_CDP_URL)` ke Chromium **yang sudah ada**, memakai default context/session browser itu, lalu membuka tab sementara. Aplikasi tidak membuat volume profil browser, tidak menyimpan kredensial LinkedIn, tidak login, dan tidak mengelola `ai-chrome` atau `ai-hermes`. [Dokumentasi CDP Playwright](https://playwright.dev/docs/api/class-browsertype).

**Penting:** selector di `src/linkedin/selectors.ts` bersifat konservatif dan telah menjalani smoke test lokal pada session LinkedIn yang login tanggal 6 Oktober 2026. LinkedIn dapat mengubah DOM kapan saja, sehingga setiap deployment tetap perlu smoke test sendiri. Layout tak dikenal, login, CAPTCHA, challenge, identitas target yang tidak cocok, atau percakapan lama menghentikan tindakan untuk pemeriksaan manusia. Tidak ada bypass atau balasan otomatis. Jangan aktifkan `AUTOMATION_ENABLED=true` di production sebelum smoke test manual di bawah selesai.

## Lokal: mock tanpa LinkedIn

Butuh Node.js 22.13+ dan npm. Dari direktori proyek:

```bash
cp .env.example .env
npm install
npm run db:init
npm run dev
```

Buka `http://127.0.0.1:3000`. Default `.env.example`: `BROWSER_WORKER=mock`, `AUTOMATION_ENABLED` kosong (aktif untuk mock), `OUTREACH_MODE=manual`. Mock tetap menjalankan simulasi lama sampai `SENT → REPLIED → HUMAN_TAKEOVER`, tanpa browser/LinkedIn. `db:init` aman diulang; migrasi v1/v2 ke v3 tidak menghapus lead. Database default `data/leads.db` memakai WAL dan timeout lock 5 detik. Node 22 mungkin menampilkan `node:sqlite ExperimentalWarning`.

Contoh CLI:

```bash
npm run cli -- template add --name "Intro" --body "Halo {{first_name}}, salam dari {{company}}."
npm run cli -- template list
npm run lead:add -- --name "Jane Doe" --url "https://www.linkedin.com/in/jane-doe/" --company "Acme" --template <template-id>
npm run lead:list
npm run lead:status -- <lead-id> QUALIFIED
npm run lead:status -- <lead-id> APPROVED
npm run outreach:run
npm run monitor:run
```

`outreach:run` dan `monitor:run` memakai worker dari environment, termasuk Playwright bila dipilih. Script lama `outreach:mock`/`monitor:mock` memaksa worker mock, tetapi tetap mengubah status dalam database yang dipilih; gunakan hanya pada database lokal/demo. Variabel template: `{{first_name}}`, `{{name}}`, `{{company}}`, `{{job_title}}`.

## Status dan workflow production

`NEW → QUALIFIED → APPROVED → SENT → REPLIED → HUMAN_TAKEOVER`; `SKIPPED` dan `FAILED` adalah cabang review. Lead harus punya template sebelum `APPROVED`. Lead `SENT`, `REPLIED`, `HUMAN_TAKEOVER`, atau `SKIPPED` tidak masuk antrean outreach. Dari lead `SENT`, tombol **Prepare follow-up** dapat menyiapkan pesan berikutnya untuk percakapan yang sama; pengiriman tetap memerlukan **Approve & send now**. Perubahan status divalidasi di service dan dicatat di activity log.

Di mode Playwright, `APPROVED` memicu verifikasi profil/percakapan, render template, dan satu record `pending_actions` per lead. `OUTREACH_MODE=manual`: manusia mengirim di LinkedIn sendiri, lalu menekan **Confirm manual send** di dashboard. `OUTREACH_MODE=approval`: **Send approved message** di dashboard atau `/approve <lead-id>` di Telegram adalah persetujuan eksplisit untuk satu percobaan kirim Playwright. Periksa teks dan penerima sebelum menekan tombol. Proses mencatat `SENDING` sebelum klik; jika proses berhenti atau hasil klik tidak pasti, pesan tidak dicoba ulang otomatis. Rekonsiliasi percakapan secara manual. `OUTREACH_DAILY_LIMIT` dihitung dalam `APP_TIMEZONE` dan diperiksa lagi saat persetujuan kirim.

Worker mencari percakapan berdasarkan nama penerima pada halaman Messaging jika overlay profil tidak terbuka. Bila riwayat percakapan sudah ada, lead menjadi `FAILED` dengan `error_class=existing_conversation`; tidak ada pending action dan tidak ada pesan yang diketik atau dikirim. Review percakapan itu secara manual.

Monitor memeriksa lead `SENT`. Worker membaca elemen percakapan untuk membedakan pesan keluar dan masuk, mengambil isi bubble chat, lalu mengubah label waktu LinkedIn seperti `Today`, `Yesterday`, nama hari, atau tanggal menjadi waktu ISO berdasarkan `APP_TIMEZONE`. Riwayat yang terbaca disimpan di tabel `conversation_messages` dan ditampilkan pada detail lead. Hanya pesan masuk sesudah outreach yang dianggap balasan; jika LinkedIn hanya memberi waktu sampai menit, urutan bubble dipakai untuk mengenali balasan pada menit yang sama. Jika belum ada balasan, `last_checked_at` diperbarui. Bila balasan terdeteksi, status menjadi `REPLIED`, lalu `HUMAN_TAKEOVER`, dengan isi balasan, `replied_at`, log, notifikasi, dan alert dashboard. Lead itu tidak diproses otomatis lagi dan worker tidak mengirim balasan. Kesalahan sementara dibatasi maksimal tiga kali; challenge/layout tak dikenal berhenti untuk review manusia. Scheduler tidak menjalankan job yang sama bersamaan; pause dan riwayat job tersimpan setelah restart.

Halaman `/human-takeover` menampilkan semua lead yang membalas, preview balasan terakhir, filter waktu dan status penanganan, tautan percakapan LinkedIn, serta sinkronisasi manual read-only. **Mark as handled** menyimpan waktu penanganan tanpa menghapus lead atau chat. Pesan masuk baru yang ditemukan setelah itu otomatis mengubahnya kembali menjadi belum ditangani. **Sync conversation now** menghormati pause, kill switch, dan pengaturan reply monitor.

## Dashboard, autentikasi, Telegram

Overview menampilkan status sistem/browser/scheduler, worker, run terakhir dan berikutnya, limit harian, pending approval, perhatian manusia, balasan, dan error. Halaman Pending berisi pesan serta aksi; Lead detail memuat timeline. Tampilan memakai tema gelap saja dengan token warna semantik bergaya shadcn/ui di `web/styles.css`; frontend tetap HTML/CSS/JavaScript. Semua endpoint data dan mutasi dilindungi session cookie; mutasi memakai CSRF token. Hanya `/api/health`, login, dan aset login yang publik. Saat `NODE_ENV=production` atau bind di luar loopback, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, dan `SESSION_SECRET` wajib. Gunakan HTTPS reverse proxy dan `COOKIE_SECURE=true` pada production. Session ada di memori proses; login ulang setelah restart.

Buat hash password tanpa memasukkan password ke argumen shell:

```bash
npm run auth:hash
# ketik password, tekan Enter, lalu Ctrl+D; salin hash ke ADMIN_PASSWORD_HASH
```

Isi `TELEGRAM_BOT_TOKEN` dan ID numerik `TELEGRAM_ALLOWED_USER_ID` untuk bot. `TELEGRAM_CHAT_ID` opsional untuk tujuan notifikasi terpisah. Isi `APP_PUBLIC_URL` agar pesan Telegram memuat link detail dashboard; URL lokal hanya dapat dibuka pada perangkat yang dapat mengakses mesin tersebut. Tanpa token, notifier mencetak ke console. Bot hanya menanggapi user yang diizinkan: `/help`, `/status`, `/pause`, `/resume`, `/leads`, `/lead <id>`, `/approve <id>`, `/reject <id>`, `/pending`, `/replies`, `/sync <id>`, `/handled <id>`, `/errors`. Di mode Playwright, `/approve` mengirim hanya bila ada pending approval dan gate aktif; `/sync` menghormati pause/kill switch; `/handled` tidak mengirim pesan LinkedIn. Kegagalan Telegram tidak menghentikan workflow inti.

Menu command didaftarkan otomatis ke chat pengguna yang diizinkan saat aplikasi dimulai. Notifikasi balasan baru menyertakan nama, isi pesan, tombol **Open LinkedIn**, **View Lead** (bila `APP_PUBLIC_URL` diisi), **Sync Now**, dan **Mark Handled**. URL lokal hanya dapat dibuka pada perangkat yang dapat mengakses laptop tersebut. Tombol tindakan memerlukan ID pengguna yang diizinkan. Perubahan koneksi Playwright memicu notifikasi offline/pulih; challenge login LinkedIn memberi alert untuk pemeriksaan manual.

Untuk menemukan ID sendiri tanpa layanan pihak ketiga, isi token di `.env`, jalankan `npm run telegram:id`, lalu kirim `/start` ketika command sedang menunggu. Salin nilai `TELEGRAM_ALLOWED_USER_ID` dan `TELEGRAM_CHAT_ID` yang ditampilkan ke `.env`, kemudian restart aplikasi. Pencarian ID ini dijalankan sebelum memasang webhook karena Telegram menonaktifkan `getUpdates` selama webhook aktif.

`AUTOMATION_ENABLED=false` adalah kill switch dari environment; restart aplikasi setelah mengubahnya. Dashboard/API tetap hidup. Tombol Pause dan `/pause` menyimpan status di SQLite; `/resume` mengaktifkan kembali. `OUTREACH_ENABLED` dan `MONITOR_ENABLED` adalah gate tambahan. `HERMES_ENABLED=false` adalah default; Hermes tidak dipakai oleh alur inti atau untuk klik, transisi, template, monitoring, dan notifikasi.

## Environment

Salin `.env.example`; jangan commit `.env`. Production wajib `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` (acak minimal 32 karakter), `COOKIE_SECURE=true` saat lewat HTTPS, `BROWSER_WORKER=playwright`, `BROWSER_CDP_URL`, `OUTREACH_MODE=manual` atau `approval`, `OUTREACH_DAILY_LIMIT`, serta `AUTOMATION_ENABLED=false` sampai verifikasi selesai. `EXTERNAL_DOCKER_NETWORK` wajib untuk Compose production. Telegram token/ID hanya jika bot dipakai. `HERMES_*` opsional. Compose menetapkan `DATABASE_PATH=/app/data/leads.db`. Gunakan `APP_PORT=3000` untuk konfigurasi Compose/healthcheck saat ini.

Mode Playwright lokal bisa diuji dengan Chromium yang **sudah berjalan** dan menyediakan CDP di loopback: set `BROWSER_WORKER=playwright`, `BROWSER_CDP_URL=http://127.0.0.1:<port>`, `AUTOMATION_ENABLED=true`, `OUTREACH_MODE=manual`. Aplikasi tidak meluncurkan Chromium sendiri. Jangan memakai profil browser pribadi untuk fixture test.

## Docker lokal

Image tidak mengunduh Chromium. Siapkan direktori yang dapat ditulis user `node` (UID 1000 di image):

```bash
mkdir -p data
docker compose config
docker compose build
docker compose run --rm app node dist/cli.js db init
docker compose up -d
curl -f http://127.0.0.1:3000/api/health
docker compose logs -f app
```

Compose memetakan dashboard hanya ke `127.0.0.1:3000` host dan memasang `./data` persisten. Bila bind mount Linux tak dapat ditulis, jalankan `sudo chown -R 1000:1000 data` sebelum migrasi. Docker lokal tetap memerlukan admin credential karena image memakai `NODE_ENV=production`; gunakan `COOKIE_SECURE=false` hanya untuk HTTP lokal.

## GitHub: perintah yang dijalankan sendiri

Proyek ini belum menjadi Git repository. Dari folder `linkedin-agent`:

```bash
git init
git status --short
git check-ignore -v .env data/leads.db
git add .
git status --short
git commit -m "Prepare linkedin-agent production integration"
# Buat repository PRIVATE kosong bernama linkedin-agent di GitHub, lalu:
git branch -M main
git remote add origin git@github.com:<username>/linkedin-agent.git
git push -u origin main
```

Periksa `git status --short` sebelum commit; jangan tambah `.env`, `data/`, profil Chrome, cookie, session, atau file kredensial. Tidak ada push otomatis.

## VPS Ubuntu 24.04: urutan deployment

Asumsi Docker + Compose, `ai-chrome`, dan `ai-hermes` sudah ada. Ini panduan, tidak dijalankan oleh proyek. Pertahankan `ai-chrome` dan profilnya; jangan masukkan ke Compose ini.

```bash
ssh <user>@<vps>
git clone git@github.com:<username>/linkedin-agent.git
cd linkedin-agent
cp .env.example .env
mkdir -p data
sudo chown -R 1000:1000 data
docker inspect ai-chrome --format '{{json .NetworkSettings.Networks}}'
docker network inspect <existing-private-network>
```

Edit `.env`: admin hash/secret, Telegram bila digunakan, `BROWSER_WORKER=playwright`, `BROWSER_CDP_URL=http://<internal-cdp-host>:9222` (atau WebSocket URL internal yang diverifikasi), `OUTREACH_MODE=manual`, `AUTOMATION_ENABLED=false`, `COOKIE_SECURE=true`, `EXTERNAL_DOCKER_NETWORK=<existing-private-network>`. Reverse proxy HTTPS di host diarahkan ke `127.0.0.1:3000`; dashboard tidak dipublikasikan langsung. Jangan isi kredensial LinkedIn ke `.env`.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm app node dist/cli.js db init
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
curl -f http://127.0.0.1:3000/api/health
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=100 app
```

Setelah CDP dan selector diverifikasi, ubah `AUTOMATION_ENABLED=true`, lalu `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate app`. Awali dengan `OUTREACH_MODE=manual` dan satu lead uji.

### Sambungan aman ke `ai-chrome`

Periksa dulu apakah `ai-chrome` sudah menyediakan CDP dan network Docker privat yang sama. `BROWSER_CDP_URL` harus bisa dijangkau **dari container app**, bukan hanya host VPS. Bila belum ada, konfigurasi minimal di deployment `ai-chrome` milik Anda adalah mengaktifkan remote debugging pada **alamat interface Docker privat tertentu** dan port internal (misalnya 9222), menggabungkan `ai-chrome` ke network privat bersama, tanpa mapping `ports:`/firewall publik untuk CDP. Parameter Chromium konseptual: `--remote-debugging-port=9222 --remote-debugging-address=<private-container-interface-IP>`. Alamat persis, dukungan image Chromium, dan URL WebSocket perlu diverifikasi pada setup `ai-chrome` yang ada; jangan mengubah profil/volume/session. Jangan bind CDP ke `0.0.0.0` atau mengeksposnya ke internet. Jika image hanya mendengar loopback, diperlukan adapter/forwarder internal yang dibatasi ke network privat; verifikasi endpoint dari app sebelum automasi dinyalakan.

### Browser khusus di VPS dengan Caddy

Untuk VPS yang sudah memakai network Docker `caddy_proxy`, salin konfigurasi Caddy sekali ke `docker-compose.override.yml`, lalu jalankan browser khusus dengan profil di `data/browser-profile`. Browser lama milik layanan lain tidak perlu diubah. Desktop browser hanya dipublikasikan ke loopback VPS pada port 3002; CDP hanya tersedia di network Docker project melalui relay internal.

```bash
cp deploy/docker-compose.caddy.yml docker-compose.override.yml
docker compose -f docker-compose.yml -f docker-compose.override.yml -f deploy/docker-compose.browser.yml up -d --build
```

Isi `.env`: `BROWSER_WORKER=playwright`, `BROWSER_CDP_URL=http://browser:9223`, `OUTREACH_MODE=manual`, dan `AUTOMATION_ENABLED=false` sampai browser serta akun LinkedIn diverifikasi. `browser` adalah nama service Docker; worker mengubahnya ke IP privat saat terhubung karena Chromium menolak nama service pada header CDP. Jangan memetakan port 9222 atau 9223 ke host.

Dari terminal laptop, buka tunnel `ssh -N -L 3002:127.0.0.1:3002 pamm`, lalu buka `https://localhost:3002` dan login LinkedIn secara manual di desktop browser tersebut. Akhiri tunnel dengan Ctrl+C; browser di VPS tetap berjalan. Verifikasi koneksi tanpa membuka profil lead atau mengirim pesan:

```bash
docker compose exec app node dist/cli.js browser health
```

Setelah login, gunakan satu lead uji dengan `OUTREACH_MODE=manual` untuk memeriksa pembacaan profil dan percakapan. Aktifkan `AUTOMATION_ENABLED=true` hanya sesudah uji itu berhasil. Mode `approval` memerlukan persetujuan eksplisit sebelum mengirim pesan.

### Operasional

**Update dan backup sebelum migrasi:** hentikan app supaya salinan `.db` konsisten. Simpan juga hash commit sebelumnya untuk rollback.

```bash
git rev-parse HEAD
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app
cp -a data/leads.db data/leads.db.bak-$(date +%Y%m%d-%H%M%S)
git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm app node dist/cli.js db init
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Simpan backup di lokasi aman di luar Git. Untuk backup online, pakai SQLite `.backup` agar WAL tercakup; jangan menyalin `.db` saat app menulis.

**Rollback:** set `AUTOMATION_ENABLED=false` di `.env`, stop app, lalu gunakan commit sebelumnya dan backup **sebelum migrasi** bila schema berubah. Kode lama tidak bisa membaca schema v4 yang lebih baru.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app
git checkout <previous-commit-hash>
cp -a <path-to-pre-migration-backup.db> data/leads.db
sudo chown 1000:1000 data/leads.db
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm app node dist/cli.js db init
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Pause** lewat dashboard Control center atau Telegram `/pause`. **Emergency kill:** ubah `.env` menjadi `AUTOMATION_ENABLED=false`, lalu jalankan `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate app`. Tindakan yang sudah terkirim tidak dapat dibatalkan; periksa `SENDING`/`UNCERTAIN` secara manual. Untuk **restore** tanpa rollback kode, stop app, salin backup yang sesuai ke `data/leads.db`, ubah ownership ke UID 1000, jalankan `db init`, lalu `up -d`.

**Browser terputus:** periksa `docker ps --filter name=ai-chrome`, `docker inspect ai-chrome --format '{{json .NetworkSettings.Networks}}'`, dan CDP dari network internal. Pulihkan browser sesuai prosedur milik Anda tanpa menghapus profil. Worker menunda job saat CDP offline. Ulangi smoke test sebelum automasi. Jangan retry `SENDING`/`UNCERTAIN` tanpa memeriksa percakapan.

## Verifikasi dan smoke test manual LinkedIn

```bash
npm run typecheck
npm test
npm run build
docker compose config
```

Test otomatis memakai mock/parser fixture tanpa LinkedIn nyata. Tidak ada script lint. Dengan `AUTOMATION_ENABLED=false` di production, cek dashboard/login, API health, migrasi, dan koneksi CDP. Pastikan session `ai-chrome` sudah login **secara manual**, lalu aktifkan automasi mode `manual` untuk **satu** lead yang disetujui: verifikasi nama/URL profil, pending action, dan tidak ada kirim oleh worker. Periksa login/challenge/layout tak dikenal menghentikan alur. Smoke test lokal 6 Oktober 2026 memverifikasi profil, fallback pencarian Messaging, dan penghentian `existing_conversation`; tidak ada pesan yang terkirim. Untuk menguji pembuatan pending action, gunakan profil yang menyetujui pengujian dan belum memiliki percakapan. Sesudah selector dan percakapan tervalidasi, bila ingin mode `approval`, uji satu pesan dengan persetujuan eksplisit dan cek `SENT`/`UNCERTAIN`; verifikasi monitor mendeteksi balasan tanpa mengirim balasan. Tidak ada test CI yang memakai LinkedIn production.
