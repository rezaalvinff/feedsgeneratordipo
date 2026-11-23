# Automotive Instagram Feeds Generator

Ubah foto studio mobil katalog (latar polos/hitam) menjadi foto komersial realistis untuk **Instagram Feed** (4:5 `1080×1350` / 1:1 `1080×1080`) dengan latar baru hasil AI.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · `@imgly/background-removal` (di browser) · HTML5 Canvas · Cloudflare Workers AI (text-to-image, fallback model otomatis).

> **Catatan model:** `@cf/runwayml/stable-diffusion-v1-5-inpainting` di-*deprecate* Cloudflare pada 2026-11-20 (HTTP 410). Karena itu aplikasi kini memakai **mode backplate**: AI menggambar latar kosong, lalu mobil resolusi asli ditempel di browser dengan bayangan kontak & pantulan buatan Canvas. Mode inpainting masih didukung bila Anda mengisi `CLOUDFLARE_AI_MODEL` dengan model inpainting yang aktif.

## Alur kerja

1. **Upload & auto-masking (client-side).** Drag & drop / klik / Ctrl+V foto mobil. Latar dihapus di browser dengan IMG.LY (ONNX/WASM), jadi serverless function Vercel tidak terbebani. PNG yang sudah transparan langsung dipakai. Ada juga fallback *latar polos* (flood-fill warna tepi) bila model gagal diunduh.
2. **Komposisi & mask.** Atur ukuran/posisi mobil di frame. Canvas membuat:
   - **image**: mobil di atas latar abu netral pada resolusi generasi (512×640 / 768×960),
   - **mask**: mobil **hitam `#000`** (dikunci), latar **putih `#FFF`** (digambar ulang), dengan *feathering* gaussian ±3–4px di tepi agar pantulan & cahaya menyatu.
   - Toggle **Debug view** menampilkan hasil isolasi, mask, input AI, dan output mentah AI.
3. **Preset prompt otomotif.** Ada 5 preset (Jakarta Golden Hour, Highland Mountain Road, Luxury Showroom, Coastal Sunset Highway, Night City Street) plus Custom Prompt. Booster *"realistic environment reflections on glossy car paint, soft contact shadows under tires, 35mm lens, photorealistic…"* bisa di-toggle. Negative prompt, steps, guidance, strength, dan seed tersedia di Pengaturan lanjutan.
4. **Generate** via `POST /api/generate` → Cloudflare Workers AI. Server mencoba model kandidat berurutan dan melewati model yang deprecated/tidak tersedia:
   `flux-2-klein-9b` → `flux-2-klein-4b` → `flux-1-schnell` → `leonardo/lucid-origin` → `leonardo/phoenix-1.0`. Model FLUX.2 dikirimi `multipart/form-data`, model lain JSON. Model yang terpakai ditampilkan di UI, dan model yang gagal/deprecated dicatat di log Vercel. (SDXL base, SDXL Lightning, SD 1.5 inpainting dan DreamShaper sudah di-deprecate per 2026-11-20 sehingga tidak ada di daftar default.)
5. **Integrasi & export.** Mobil resolusi asli ditempel di atas latar AI. Yang bisa diatur: **bayangan kontak ban** (siluet di-squash + blur), **pantulan lantai** (showroom/aspal basah), **pantulan lingkungan di cat** (latar dicerminkan + blur, soft-light), *ambient color blend*, dan kelembutan tepi. Lalu Before vs After berdampingan, Auto-Crop (fokus ke mobil) atau Fit (latar blur) ke 4:5 / 1:1, watermark logo (upload/tempel, 4 pojok), dan download JPG/PNG high-res sekali klik.

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
- Opsional: `CLOUDFLARE_AI_MODEL` (paksa model/daftar model, dipisah koma) dan `CLOUDFLARE_API_BASE_URL` (lewat AI Gateway). Lihat `.env.example`.

Badge di header menampilkan status konfigurasi (`GET /api/generate` → `{ configured: boolean }`, nilai secret tidak pernah dikirim ke browser).

## Deploy ke Vercel

1. Import repo di Vercel (framework terdeteksi otomatis sebagai Next.js).
2. *Project Settings → Environment Variables*: tambahkan `CLOUDFLARE_ACCOUNT_ID` dan `CLOUDFLARE_API_TOKEN`.
3. Deploy. Route `/api/generate` memakai runtime Node.js dengan `maxDuration = 60` detik.

## API `POST /api/generate`

Body JSON:

| field | tipe | keterangan |
|---|---|---|
| `prompt` | string | wajib. Prompt latar kosong (mode backplate) |
| `negative_prompt` | string | opsional |
| `inpaint_prompt`, `inpaint_negative_prompt` | string | dipakai bila model inpainting |
| `image`, `mask` | string | data URL / base64 PNG/JPG (maks 3MB). Wajib hanya untuk model inpainting. Mask: hitam = dikunci, putih = digambar ulang |
| `aspect` | `"4:5"` \| `"1:1"` | ukuran generasi disesuaikan per model |
| `quality` | `"standard"` \| `"high"` | |
| `num_steps`, `guidance`, `strength`, `seed` | number | dipetakan ke parameter masing-masing model |

Respons sukses: `{ image: "data:image/...;base64,...", model, mode: "backplate" | "inpaint", seed, attempts }`.
Respons error: `{ error, code, details?, attempts? }`, dengan `code` salah satu dari `MISSING_ENV` (500), `INVALID_REQUEST` (400), `UNAUTHORIZED` (401), `RATE_LIMITED` (429), `TIMEOUT` (504), `NETWORK_ERROR` / `UPSTREAM_ERROR` (502). `attempts` berisi daftar model yang dicoba beserta pesan error-nya.

## Catatan

- **Model masking** (~40–170MB tergantung varian Cepat/Seimbang/Terbaik) diunduh sekali dari CDN `staticimgly.com` lalu di-cache browser. Kalau CDN diblokir jaringan/ad-blocker, pakai fallback *latar polos*.
- **Lisensi:** `@imgly/background-removal` berlisensi **AGPL-3.0**. Untuk penggunaan komersial closed-source, cek lisensi komersial dari IMG.LY.
- Foto tidak disimpan di server. Gambar hanya diteruskan ke Cloudflare untuk proses generate.
- Free tier Workers AI memberi 10.000 neurons/hari. Biaya per gambar berbeda-beda per model.

## Struktur

```
app/
  api/generate/route.ts   # proxy ke Cloudflare Workers AI + fallback model + error handling
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
