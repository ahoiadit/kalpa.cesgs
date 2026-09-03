# KALPA — Deploy GitHub + Vercel

Pola sama dengan Research Hub. Bukan PHP. Antarmuka statis (`index.html`) plus
satu proxy Node di `api/index.js`. Proxy menangani login (cookie sesi bertanda),
menyembunyikan URL dan token Apps Script dari peramban, lalu meneruskan
permintaan ke Apps Script yang menjadi basis data (Google Sheet).

```
kalpa-deploy/
├── index.html        # app: login, pemilih Acute/Chronic, slot modul
├── api/
│   └── index.js      # proxy Node (login gate + teruskan ke Apps Script)
├── server.js         # server lokal / VPS (Vercel tidak memakainya)
├── package.json
├── vercel.json
├── .env.example
├── Code.gs           # backend Apps Script (di-paste ke editor, bukan di-deploy)
├── .gitignore
└── .vercelignore
```

Alur di layar: buka halaman, kalau belum login muncul layar masuk. Setelah
masuk muncul pemilih dua modul, KALPA Acute dan KALPA Chronic. Keduanya berbagi
satu lembar data, jadi aset yang dicatat di satu modul terbaca di modul lain.

---

## 1. Google Sheet + Apps Script

1. Buat satu Google Sheet kosong. Catat ID-nya (potongan URL di antara `/d/`
   dan `/edit`).
2. `Extensions > Apps Script`. Hapus isi bawaan, tempel seluruh `Code.gs`.
3. Isi di atas `Code.gs`:
   - `SHEET_ID` = ID Sheet tadi.
   - `TOKEN` = string acak bebas (mis. `kalpa-tok-9f3a...`). Nilai ini nanti
     dipakai sebagai `KALPA_GAS_TOKEN` di Vercel. Boleh dikosongkan kalau tidak
     ingin token, tapi sebaiknya diisi.
4. `Run > tesSeed` sekali. Ini membuat lembar `KALPA_Akun` dan `KALPA_Data`,
   satu akun admin contoh, dan satu baris data contoh. Buka Sheet, ganti sandi
   akun contoh dan tambah akun lain (kolom email, sandi, nama, peran).
5. `Deploy > New deployment > Web app`:
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Salin URL yang berakhiran `/exec`. Itu `KALPA_GAS_URL`.

---

## 2. Push ke GitHub

Buat repo baru, unggah semua berkas folder ini, commit, push.

---

## 3. Deploy Vercel

1. Vercel > Add New > Project > import repo.
2. Framework Preset **Other**. Root default, Build & Output kosong. `api/index.js`
   otomatis dijadikan Serverless Function Node, tidak perlu setelan runtime.
3. `Settings > Environment Variables`, isi:
   - `KALPA_GAS_URL` = URL `/exec` dari langkah 1.
   - `KALPA_SESSION_SECRET` = string acak panjang (untuk menandatangani cookie).
   - `KALPA_GAS_TOKEN` = sama persis dengan `TOKEN` di `Code.gs` (kosongkan bila
     `TOKEN` juga kosong).
4. Deploy. Buka domainnya, coba masuk pakai akun contoh. Setelah masuk, buka
   salah satu modul dan tekan Simpan di panel uji untuk memastikan data benar
   masuk Sheet.

Uji cepat proxy tanpa membuka halaman: `https://domainmu/api` dengan body
`{"action":"diag"}` (POST) mengembalikan status koneksi ke Apps Script tanpa
membocorkan URL, token, atau secret.

---

## 4. Jalan lokal (opsional)

```
cp .env.example .env      # isi KALPA_GAS_URL + KALPA_SESSION_SECRET
npm start                 # http://localhost:3000
```

`KALPA_COOKIE_SECURE=false` di `.env` bila menguji lewat http biasa.

---

## 5. Pasang modul KALPA

Di `index.html` ada dua slot bertanda:

```
<!-- SLOT MODUL ACUTE ... -->
<!-- SLOT MODUL CHRONIC ... -->
```

Isi modul Acute dan Chronic dari `kalpa-merged.html` ditempel menggantikan blok
`.kslot` di masing-masing slot. Sambungkan tombol simpan/muat modul ke store
yang sama:

```js
// simpan
await KalpaAPI.sync([{ uid: aset.uid || KalpaAPI.uid(), modul: 'Acute',
  nama_aset: aset.nama, lokasi: aset.lokasi, skor_risiko: hasil.skor }], []);

// muat semua data (kedua modul berbagi ini)
const snap = await KalpaAPI.pull();
const asetAcute = snap.data.filter(r => r.modul === 'Acute');
```

Karena kedua modul memanggil `KalpaAPI.pull()` yang sama, sinkronisasi aset
Acute dan Chronic terjadi lewat basis data bersama, bukan pengikatan di halaman.
Kolom lembar dibuat otomatis dari field yang dikirim, jadi menambah field baru
tidak perlu mengedit spreadsheet.

---

## Kontrak proxy (`/api`, POST JSON)

| action  | kirim                                   | balas |
|---------|-----------------------------------------|-------|
| me      | `{}`                                    | `{ ok, user }` (user null bila belum masuk) |
| login   | `{ mail, sandi }`                       | `{ ok, akun }` + set cookie sesi |
| logout  | `{}`                                    | `{ ok:true }` |
| pull    | `{}`                                    | `{ ok, data:[], akun:[] }` |
| sync    | `{ records:[{uid,..}], deleted:[uid] }` | `{ ok, data:[], akun:[] }` |
| diag    | `{}`                                    | status koneksi Apps Script |

`uid` adalah kunci upsert. `updated_at` diisi otomatis. Kolom sandi tidak pernah
dikirim ke peramban.
