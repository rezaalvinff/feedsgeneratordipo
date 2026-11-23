# Automotive Instagram Feeds Generator

Ubah foto studio mobil katalog (latar polos/hitam) menjadi foto komersial realistis untuk **Instagram Feed** (4:5 `1080×1350` / 1:1 `1080×1080`) dengan latar baru hasil AI.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · `@imgly/background-removal` (di browser) · HTML5 Canvas · Cloudflare Workers AI (`@cf/runwayml/stable-diffusion-v1-5-inpainting`).

## Alur kerja

1. **Upload & auto-masking (client-side).** Drag & drop / klik / Ctrl+V foto mobil. Latar dihapus di browser dengan IMG.LY (ONNX/WASM), jadi serverless function Vercel tidak terbebani. PNG yang sudah transparan langsung dipakai. Ada juga fallback *latar polos* (flood-fill warna tepi) bila model gagal diunduh.
2. **Komposisi & mask.** Atur ukuran/posisi mobil di frame. Canvas membuat:
   - **image**: mobil di atas latar abu netral pada resolusi generasi (512×640 / 768×960),
   - **mask**: mobil **hitam `#000`** (dikunci), latar **putih `#FFF`** (digambar ulang), dengan *feathering* gaussian ±3–4px di tepi agar pantulan & cahaya menyatu.
   - Toggle **Debug view** menampilkan hasil isolasi, mask, input AI, dan output mentah AI.
3. **Preset prompt otomotif.** Ada 5 preset (Jakarta Golden Hour, Highland Mountain Road, Luxury Showroom, Coastal Sunset Highway, Night City Street) plus Custom Prompt. Booster *"realistic environment reflections on glossy car paint, soft contact shadows under tires, 35mm lens, photorealistic…"* bisa di-toggle. Negative prompt, steps, guidance, strength, dan seed tersedia di Pengaturan lanjutan.
4. **Generate** via `POST /api/generate` → Cloudflare Workers AI.
5. **Framing & export.** Before vs After berdampingan, Auto-Crop (fokus ke mobil) atau Fit (latar blur) ke 4:5 / 1:1, dan watermark logo (upload/tempel, 4 pojok, ukuran/opacity/margin). Opsi **Pertahankan detail mobil** menempel ulang mobil resolusi asli di atas hasil AI (SD 1.5 hanya ~512px), dengan tepi lembut + *ambient color blend*. Download JPG/PNG high-res sekali klik.

## Setup lokal

```bash
npm install
cp .env.example .env.local   # lalu isi kredensial
npm run dev                  # http://localhost:3000
```

`.env.local` (sudah masuk `.gitignore`):

```env
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
```

- **Account ID**: Cloudflare Dashboard → *Workers & Pages* (atau *AI*) → Account ID di sidebar kanan.
- **API Token**: *My Profile → API Tokens → Create Token* → template **Workers AI** (permission `Workers AI: Read`).

Badge di header menampilkan status konfigurasi (`GET /api/generate` → `{ configured: boolean }`, nilai secret tidak pernah dikirim ke browser).

## Deploy ke Vercel

1. Import repo di Vercel (framework terdeteksi otomatis sebagai Next.js).
2. *Project Settings → Environment Variables*: tambahkan `CLOUDFLARE_ACCOUNT_ID` dan `CLOUDFLARE_API_TOKEN`.
3. Deploy. Route `/api/generate` memakai runtime Node.js dengan `maxDuration = 60` detik.

## API `POST /api/generate`

Body JSON:

| field | tipe | keterangan |
|---|---|---|
| `image` | string | data URL / base64 PNG atau JPG (maks 3MB) |
| `mask` | string | data URL / base64 PNG, hitam = dikunci, putih = digambar ulang |
| `prompt` | string | wajib |
| `negative_prompt` | string | opsional |
| `width`, `height` | number | 256–1024, kelipatan 8 |
| `num_steps` | number | 1–20 (default 20) |
| `guidance` | number | default 7.5 |
| `strength` | number | 0–1 (default 1) |
| `seed` | number | opsional |

Respons sukses: `{ image: "data:image/png;base64,...", seed, model }`.
Respons error: `{ error, code, details? }`, dengan `code` salah satu dari `MISSING_ENV` (500), `INVALID_REQUEST` (400), `UNAUTHORIZED` (401), `RATE_LIMITED` (429, termasuk kuota harian neurons habis), `TIMEOUT` (504), `NETWORK_ERROR` / `UPSTREAM_ERROR` (502).

## Catatan

- **Model masking** (~40–170MB tergantung varian Cepat/Seimbang/Terbaik) diunduh sekali dari CDN `staticimgly.com` lalu di-cache browser. Kalau CDN diblokir jaringan/ad-blocker, pakai fallback *latar polos*.
- **Lisensi:** `@imgly/background-removal` berlisensi **AGPL-3.0**. Untuk penggunaan komersial closed-source, cek lisensi komersial dari IMG.LY.
- Foto tidak disimpan di server. Gambar hanya diteruskan ke Cloudflare untuk proses generate.
- Free tier Workers AI memberi 10.000 neurons/hari. Satu generate SD 1.5 inpainting memakai sebagian kecil dari kuota itu.

## Struktur

```
app/
  api/generate/route.ts   # proxy ke Cloudflare Workers AI + error handling
  layout.tsx, page.tsx, globals.css
components/
  Studio.tsx              # UI utama & state
  Dropzone.tsx, ui.tsx
lib/
  segmentation.ts         # IMG.LY background removal + fallback latar polos
  pipeline.ts             # layout, mask feathering, komposit, framing IG, watermark
  image.ts                # util canvas (gaussian blur, trim, dll)
  presets.ts              # preset prompt otomotif
```
