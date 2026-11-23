import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Urutan model kandidat. Per 2026-11-20 Cloudflare men-deprecate (HTTP 410, error 5028)
 * stable-diffusion-xl-base-1.0, stable-diffusion-v1-5-inpainting, stable-diffusion-xl-lightning
 * dan dreamshaper-8-lcm; pengganti resminya flux-2-klein-9b. Route ini mencoba model
 * berikutnya bila model ditolak (410 / 404 / 400 / 5xx).
 * Override lewat env `CLOUDFLARE_AI_MODEL` (satu atau beberapa id dipisah koma).
 */
const DEFAULT_MODELS = [
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/leonardo/lucid-origin",
  "@cf/leonardo/phoenix-1.0",
];

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // jaga di bawah limit body 4.5MB Vercel
const TOTAL_BUDGET_MS = 55_000;
const MIN_ATTEMPT_MS = 6_000;

type ErrorCode =
  | "MISSING_ENV"
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR";

type Aspect = "4:5" | "1:1";
type Quality = "standard" | "high";
type Mode = "backplate" | "inpaint";

class RequestError extends Error {}

interface Attempt {
  model: string;
  status: number | null;
  message: string;
}

function fail(status: number, code: ErrorCode, error: string, extra?: { details?: string; attempts?: Attempt[] }) {
  return NextResponse.json({ error, code, ...extra }, { status });
}

function getConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const override = process.env.CLOUDFLARE_AI_MODEL?.split(",").map((s) => s.trim()).filter(Boolean);
  const models = override?.length ? override : DEFAULT_MODELS;
  // Opsional: arahkan lewat Cloudflare AI Gateway, mis.
  // https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/<GATEWAY>/workers-ai
  const baseUrl = process.env.CLOUDFLARE_API_BASE_URL?.trim().replace(/\/+$/, "");
  return { accountId, apiToken, models, baseUrl };
}

function decodeImage(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestError(`Field "${field}" wajib diisi (data URL atau base64 PNG/JPG).`);
  }
  const match = value.match(/^data:image\/(?:png|jpe?g|webp);base64,(.*)$/s);
  const b64 = (match ? match[1] : value).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new RequestError(`Field "${field}" bukan base64 yang valid.`);
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) throw new RequestError(`Field "${field}" kosong.`);
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new RequestError(`Field "${field}" terlalu besar (${(buf.length / 1024 / 1024).toFixed(1)}MB, maks 3MB).`);
  }
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpg) throw new RequestError(`Field "${field}" harus berupa PNG atau JPG.`);
  return new Uint8Array(buf);
}

function num(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new RequestError(`Field "${field}" harus angka antara ${min} dan ${max}.`);
  return n;
}

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

interface GenInput {
  prompt: string;
  negative: string;
  inpaintPrompt: string;
  inpaintNegative: string;
  aspect: Aspect;
  quality: Quality;
  steps: number;
  guidance: number;
  strength: number;
  seed?: number;
  image?: Uint8Array;
  mask?: Uint8Array;
}

const isInpaintModel = (model: string) => model.includes("inpaint");

/** Ukuran output per keluarga model (kelipatan 8, rasio 4:5 atau 1:1). */
function sizeFor(family: "sd15" | "sdxl" | "leonardo" | "flux2", aspect: Aspect, quality: Quality) {
  const base = family === "sd15" ? (quality === "high" ? 768 : 512) : quality === "high" ? 1024 : 768;
  return aspect === "4:5" ? { width: base, height: Math.round((base * 1.25) / 8) * 8 } : { width: base, height: base };
}

/** Bangun body request sesuai skema tiap keluarga model. */
function buildBody(model: string, input: GenInput): { body: Record<string, unknown>; mode: Mode; multipart?: boolean } {
  const seed = input.seed !== undefined ? { seed: input.seed } : {};

  if (isInpaintModel(model)) {
    if (!input.image || !input.mask) throw new RequestError("Model inpainting membutuhkan field image dan mask.");
    const { width, height } = sizeFor("sd15", input.aspect, input.quality);
    return {
      mode: "inpaint",
      body: {
        prompt: input.inpaintPrompt,
        ...(input.inpaintNegative ? { negative_prompt: input.inpaintNegative } : {}),
        image: Array.from(input.image),
        mask: Array.from(input.mask),
        width,
        height,
        num_steps: Math.min(20, input.steps),
        guidance: input.guidance,
        strength: input.strength,
        ...seed,
      },
    };
  }

  if (model.includes("/flux-2-")) {
    // FLUX.2 (dev / klein) di Workers AI menerima multipart/form-data.
    // Kirim field minimal: prompt, width, height, seed.
    const { width, height } = sizeFor("flux2", input.aspect, input.quality);
    return { mode: "backplate", multipart: true, body: { prompt: input.prompt, width, height, ...seed } };
  }

  if (model.includes("flux-1-schnell")) {
    // FLUX.1 schnell: hanya prompt, steps (maks 8), seed. Output 1024×1024 (di-crop di browser).
    return { mode: "backplate", body: { prompt: input.prompt, steps: Math.min(8, Math.max(4, Math.round(input.steps / 2.5))), ...seed } };
  }

  if (model.includes("/leonardo/")) {
    const { width, height } = sizeFor("leonardo", input.aspect, input.quality);
    return {
      mode: "backplate",
      body: {
        prompt: input.prompt,
        ...(model.includes("phoenix") && input.negative ? { negative_prompt: input.negative } : {}),
        width,
        height,
        ...seed,
      },
    };
  }

  // Keluarga Stable Diffusion (SDXL, SDXL Lightning, DreamShaper, dll.)
  const family = model.includes("dreamshaper") || model.includes("v1-5") ? "sd15" : "sdxl";
  const { width, height } = sizeFor(family, input.aspect, input.quality);
  const lightning = model.includes("lightning") || model.includes("lcm");
  return {
    mode: "backplate",
    body: {
      prompt: input.prompt,
      ...(input.negative ? { negative_prompt: input.negative } : {}),
      width,
      height,
      num_steps: lightning ? Math.min(8, input.steps) : Math.min(20, input.steps),
      ...(lightning ? {} : { guidance: input.guidance }),
      ...seed,
    },
  };
}

/** Body multipart; fetch otomatis mengisi Content-Type + boundary. */
function toFormData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) form.append(k, String(v));
  return form;
}

type CfJson = { success?: boolean; result?: { image?: string }; image?: string; errors?: { code?: number; message?: string }[] };

function parseErrors(raw: string): { message: string; json: CfJson | null } {
  let json: CfJson | null = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const message =
    json?.errors?.map((e) => `${e.code ? `[${e.code}] ` : ""}${e.message ?? ""}`).join("; ") || raw.slice(0, 400) || "(tanpa pesan)";
  return { message, json };
}

/** Status konfigurasi (tanpa membocorkan nilai secret). */
export async function GET() {
  const { accountId, apiToken, models } = getConfig();
  return NextResponse.json({ configured: Boolean(accountId && apiToken), models });
}

export async function POST(req: NextRequest) {
  const { accountId, apiToken, models, baseUrl } = getConfig();
  if (!accountId || !apiToken) {
    const missing = [!accountId && "CLOUDFLARE_ACCOUNT_ID", !apiToken && "CLOUDFLARE_API_TOKEN"].filter(Boolean).join(" & ");
    return fail(
      500,
      "MISSING_ENV",
      `Environment variable ${missing} belum diisi. Isi di .env.local (lokal) atau Project Settings → Environment Variables di Vercel, lalu restart dev server / redeploy.`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return fail(400, "INVALID_REQUEST", "Body request harus berupa JSON.");
  }

  let input: GenInput;
  try {
    const prompt = str(payload.prompt);
    if (!prompt) throw new RequestError('Field "prompt" wajib diisi.');
    const aspect: Aspect = payload.aspect === "1:1" ? "1:1" : "4:5";
    const quality: Quality = payload.quality === "high" ? "high" : "standard";
    input = {
      prompt,
      negative: str(payload.negative_prompt),
      inpaintPrompt: str(payload.inpaint_prompt) || prompt,
      inpaintNegative: str(payload.inpaint_negative_prompt) || str(payload.negative_prompt),
      aspect,
      quality,
      steps: Math.round(num(payload.num_steps, 20, 1, 50, "num_steps")),
      guidance: num(payload.guidance, 7.5, 0, 30, "guidance"),
      strength: num(payload.strength, 1, 0, 1, "strength"),
      seed: payload.seed === undefined || payload.seed === null ? undefined : Math.floor(num(payload.seed, 0, 0, 4_294_967_295, "seed")),
    };
    // image & mask hanya wajib untuk model inpainting, tapi divalidasi bila dikirim.
    if (payload.image !== undefined) input.image = decodeImage(payload.image, "image");
    if (payload.mask !== undefined) input.mask = decodeImage(payload.mask, "mask");
  } catch (err) {
    if (err instanceof RequestError) return fail(400, "INVALID_REQUEST", err.message);
    throw err;
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const attempts: Attempt[] = [];

  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) break;

    let built: ReturnType<typeof buildBody>;
    try {
      built = buildBody(model, input);
    } catch (err) {
      attempts.push({ model, status: null, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const url = baseUrl
      ? `${baseUrl}/${model}`
      : `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        ...(built.multipart
          ? { headers: { Authorization: `Bearer ${apiToken}` }, body: toFormData(built.body) }
          : {
              headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
              body: JSON.stringify(built.body),
            }),
        signal: AbortSignal.timeout(remaining),
        cache: "no-store",
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        return fail(504, "TIMEOUT", "Cloudflare Workers AI tidak merespons tepat waktu. Coba lagi beberapa saat lagi.", { attempts });
      }
      return fail(502, "NETWORK_ERROR", "Tidak dapat terhubung ke Cloudflare Workers AI.", {
        details: err instanceof Error ? err.message : undefined,
        attempts,
      });
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const ok = (image: string, mime: string) =>
      NextResponse.json({ image: `data:${mime};base64,${image}`, model, mode: built.mode, seed: input.seed ?? null, attempts });

    if (upstream.ok && contentType.startsWith("image/")) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return ok(buf.toString("base64"), contentType.split(";")[0]);
    }

    const raw = await upstream.text();
    const { message, json } = parseErrors(raw);
    const b64 = json?.result?.image ?? json?.image;
    if (upstream.ok && b64) {
      const mime = b64.startsWith("/9j/") ? "image/jpeg" : "image/png";
      return ok(b64, mime);
    }

    attempts.push({ model, status: upstream.status, message });
    if (upstream.status === 410 || message.includes("5028") || message.toLowerCase().includes("deprecated")) {
      console.warn(`[generate] Model ${model} sudah deprecated (HTTP ${upstream.status}); lanjut ke model berikutnya.`);
    } else {
      console.warn(`[generate] Model ${model} gagal (HTTP ${upstream.status}): ${message}`);
    }
    const lower = message.toLowerCase();

    // Error yang tidak akan beres dengan mengganti model -> berhenti.
    if (upstream.status === 401 || upstream.status === 403 || lower.includes("authentication")) {
      return fail(
        401,
        "UNAUTHORIZED",
        'Autentikasi Cloudflare gagal. Pastikan CLOUDFLARE_API_TOKEN valid dan memiliki permission "Workers AI", serta CLOUDFLARE_ACCOUNT_ID benar.',
        { details: message, attempts },
      );
    }
    if (upstream.status === 429 || lower.includes("neuron") || lower.includes("rate limit") || lower.includes("daily free allocation")) {
      return fail(
        429,
        "RATE_LIMITED",
        "Kuota / rate limit Cloudflare Workers AI tercapai (free tier: 10.000 neurons per hari). Tunggu sebentar atau upgrade ke Workers Paid.",
        { details: message, attempts },
      );
    }
    // 410 (deprecated), 404 (model tidak ada), 400 (skema berbeda), 5xx -> coba model berikutnya.
  }

  return fail(502, "UPSTREAM_ERROR", "Semua model kandidat Cloudflare Workers AI gagal. Lihat daftar percobaan di bawah.", {
    details: attempts.map((a) => `${a.model} → ${a.status ?? "-"} ${a.message}`).join("\n"),
    attempts,
  });
}
