# Deploy ke VPS dengan IP publik, tanpa domain

Telegram webhook membutuhkan **HTTPS** yang dapat dijangkau dari internet. Panduan ini memakai sertifikat untuk IP publik dari Let's Encrypt, Nginx di host VPS, dan aplikasi Docker yang tetap bind ke `127.0.0.1:3000`. Sertifikat IP Let's Encrypt berlaku sekitar 6 hari, jadi renewal otomatis wajib. Butuh Certbot **5.4+**, IPv4 publik tetap, dan port **80/443** terbuka. Ikuti [panduan resmi Let's Encrypt untuk sertifikat IP](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) dan [syarat webhook Telegram](https://core.telegram.org/bots/webhooks).

## 1. Siapkan source dan konfigurasi

Salin project ke VPS melalui GitHub private atau metode transfer yang Anda pilih. Jangan salin `.env`, `data/leads.db`, profil browser, atau token ke GitHub. Contoh di bawah dijalankan dari folder `linkedin-agent` di VPS.

```bash
cp .env.example .env
mkdir -p data
sudo chown -R 1000:1000 data
```

Isi `.env` pada VPS:

```env
APP_PUBLIC_URL=https://IP_PUBLIK
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://IP_PUBLIK/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=RAHASIA_ACAK_MINIMAL_16_KARAKTER
TELEGRAM_BOT_TOKEN=TOKEN_BOT_ANDA
TELEGRAM_ALLOWED_USER_ID=ID_TELEGRAM_ANDA
TELEGRAM_CHAT_ID=ID_CHAT_ANDA
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=HASH_DARI_NPM_RUN_AUTH_HASH
SESSION_SECRET=RAHASIA_ACAK_MINIMAL_32_KARAKTER
COOKIE_SECURE=true
BROWSER_WORKER=playwright
BROWSER_CDP_URL=http://NAMA_BROWSER_INTERNAL:9222
AUTOMATION_ENABLED=false
EXTERNAL_DOCKER_NETWORK=NAMA_NETWORK_BROWSER_INTERNAL
```

Gunakan `openssl rand -hex 32` untuk masing-masing secret. Jalankan `npm run auth:hash` pada mesin dengan Node.js untuk menghasilkan hash password; salin **hash saja**. Pastikan `BROWSER_CDP_URL` dapat diakses dari container aplikasi di jaringan Docker privat, tidak dipublikasikan ke internet. Awali dengan `AUTOMATION_ENABLED=false`; nyalakan sesudah verifikasi browser dan satu lead uji.

## 2. Pasang HTTPS untuk IP

Pasang Nginx dan Certbot 5.4+ di host VPS. Ganti IP contoh berikut dengan IPv4 publik VPS.

```bash
PUBLIC_IP=203.0.113.10
sudo mkdir -p /var/www/linkedin-agent/.well-known/acme-challenge
sed "s/REPLACE_WITH_PUBLIC_IP/${PUBLIC_IP}/g" deploy/nginx-bootstrap.conf | sudo tee /etc/nginx/sites-available/linkedin-agent >/dev/null
sudo ln -s /etc/nginx/sites-available/linkedin-agent /etc/nginx/sites-enabled/linkedin-agent
sudo nginx -t
sudo systemctl reload nginx
certbot --version
```

Setelah port 80 terbuka dan Certbot versi 5.4 atau lebih baru terpasang, ambil sertifikat IP:

```bash
sudo certbot certonly --preferred-profile shortlived --webroot --webroot-path /var/www/linkedin-agent --ip-address "$PUBLIC_IP"
sed "s/REPLACE_WITH_PUBLIC_IP/${PUBLIC_IP}/g" deploy/nginx-ip.conf | sudo tee /etc/nginx/sites-available/linkedin-agent >/dev/null
sudo nginx -t
sudo systemctl reload nginx
sudo install -m 755 deploy/reload-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

Jika Certbot berasal dari Snap, periksa nama timer renewal yang disediakan instalasi tersebut dan pastikan renewal aktif. Hook `reload-nginx.sh` memuat sertifikat baru setelah renewal. Cek hasil HTTPS dengan `curl -I https://IP_PUBLIK/api/health` setelah app hidup. Jika Nginx gagal karena sertifikat belum ada, ulangi langkah Certbot saat konfigurasi bootstrap masih aktif.

## 3. Jalankan aplikasi

`docker-compose.prod.yml` menggabungkan aplikasi ke network Docker privat yang sudah dipakai Chromium. Jangan membuat atau menghapus profil browser lewat project ini.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm app node dist/cli.js db init
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
curl -f http://127.0.0.1:3000/api/health
curl -f https://IP_PUBLIK/api/health
```

Dashboard berada di `https://IP_PUBLIK`. Port aplikasi 3000 hanya terbuka di loopback VPS; buka dashboard melalui Nginx pada port 443. Masuk memakai admin credential yang ada di `.env`.

## 4. Pindahkan bot dari polling ke webhook

Hentikan proses `npm run dev` di laptop yang memakai **token bot yang sama**. Setelah endpoint HTTPS VPS hidup, daftarkan webhook dari container:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm app node dist/telegram/webhook-cli.js set
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm app node dist/telegram/webhook-cli.js info
```

`info` harus menampilkan URL webhook dan tidak ada `lastError`. Kirim `/start` dan `/status` ke bot. Menu command didaftarkan otomatis saat aplikasi start. Uji tombol **Sync Now** dan **Mark Handled** menggunakan lead uji. Notifikasi balasan menampilkan isi pesan, Open LinkedIn, View Lead, dan kedua tombol tindakan.

Webhook memakai `X-Telegram-Bot-Api-Secret-Token` dan aplikasi tetap memeriksa `TELEGRAM_ALLOWED_USER_ID`. Bila perlu kembali ke polling lokal, hapus webhook terlebih dahulu:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm app node dist/telegram/webhook-cli.js delete
```

Setelah itu hentikan app VPS atau ganti mode/token, lalu jalankan aplikasi lokal dengan `TELEGRAM_MODE=polling`. Satu token bot sebaiknya dipakai oleh satu instance aplikasi aktif.

## Pemeriksaan ketika pesan tidak dibalas

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=100 app
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm app node dist/telegram/webhook-cli.js info
sudo nginx -t
sudo certbot certificates
```

Jika `lastError` berisi masalah sertifikat atau koneksi, periksa IP publik, firewall port 443, tanggal kedaluwarsa sertifikat, dan Nginx. Jika `/status` berfungsi tetapi **View Lead** tidak dapat dibuka, periksa `APP_PUBLIC_URL` dan login dashboard.
