import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Inpainting SD 1.5 biasanya selesai < 20 detik; beri ruang untuk antrian.
export const maxDuration = 60;

const MODEL = "@cf/runwayml/stable-diffusion-v1-5-inpainting";
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // jaga di bawah limit body 4.5MB Vercel
const UPSTREAM_TIMEOUT_MS = 55_000;

type ErrorCode =
  | "MISSING_ENV"
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR";

class RequestError extends Error {}

function fail(status: number, code: ErrorCode, error: string, details?: string) {
  return NextResponse.json({ error, code, ...(details ? { details } : {}) }, { status });
}

function getCredentials() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  return { accountId, apiToken };
}

function decodeImage(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestError(`Field "${field}" wajib diisi (data URL atau base64 PNG/JPG).`);
  }
  const match = value.match(/^data:image\/(?:png|jpe?g|webp);base64,(.*)$/s);
  const b64 = (match ? match[1] : value).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new RequestError(`Field "${field}" bukan base64 yang valid.`);
  }
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
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new RequestError(`Field "${field}" harus angka antara ${min} dan ${max}.`);
  }
  return n;
}

function dimension(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = num(value, 512, 256, 1024, field);
  if (n % 8 !== 0) throw new RequestError(`Field "${field}" harus kelipatan 8.`);
  return n;
}

/** Status konfigurasi (tanpa membocorkan nilai secret). */
export async function GET() {
  const { accountId, apiToken } = getCredentials();
  return NextResponse.json({ configured: Boolean(accountId && apiToken), model: MODEL });
}

export async function POST(req: NextRequest) {
  const { accountId, apiToken } = getCredentials();
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

  let body: Record<string, unknown>;
  try {
    const image = decodeImage(payload.image, "image");
    const mask = decodeImage(payload.mask, "mask");
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    if (!prompt) throw new RequestError('Field "prompt" wajib diisi.');
    if (prompt.length > 2000) throw new RequestError("Prompt terlalu panjang (maks 2000 karakter).");
    const negative = typeof payload.negative_prompt === "string" ? payload.negative_prompt.trim().slice(0, 2000) : "";

    body = {
      prompt,
      ...(negative ? { negative_prompt: negative } : {}),
      image: Array.from(image),
      mask: Array.from(mask),
      num_steps: Math.round(num(payload.num_steps, 20, 1, 20, "num_steps")),
      guidance: num(payload.guidance, 7.5, 0, 30, "guidance"),
      strength: num(payload.strength, 1, 0, 1, "strength"),
    };
    const width = dimension(payload.width, "width");
    const height = dimension(payload.height, "height");
    if (width) body.width = width;
    if (height) body.height = height;
    if (payload.seed !== undefined && payload.seed !== null) {
      body.seed = Math.floor(num(payload.seed, 0, 0, 4_294_967_295, "seed"));
    }
  } catch (err) {
    if (err instanceof RequestError) return fail(400, "INVALID_REQUEST", err.message);
    throw err;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${MODEL}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "image/png, application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return fail(504, "TIMEOUT", "Cloudflare Workers AI tidak merespons dalam 55 detik. Coba lagi beberapa saat lagi.");
    }
    return fail(502, "NETWORK_ERROR", "Tidak dapat terhubung ke Cloudflare Workers AI.", err instanceof Error ? err.message : undefined);
  }

  const contentType = upstream.headers.get("content-type") ?? "";

  if (upstream.ok && contentType.startsWith("image/")) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    return NextResponse.json({
      image: `data:${contentType.split(";")[0]};base64,${buf.toString("base64")}`,
      seed: body.seed ?? null,
      model: MODEL,
    });
  }

  // Respons JSON (error, atau sukses dalam bentuk base64)
  const raw = await upstream.text();
  let json: { success?: boolean; result?: { image?: string }; errors?: { code?: number; message?: string }[] } | null = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }

  if (upstream.ok && json?.result?.image) {
    return NextResponse.json({ image: `data:image/png;base64,${json.result.image}`, seed: body.seed ?? null, model: MODEL });
  }

  const details = json?.errors?.map((e) => `${e.code ? `[${e.code}] ` : ""}${e.message ?? ""}`).join("; ") || raw.slice(0, 500) || undefined;
  const lower = (details ?? "").toLowerCase();

  if (upstream.status === 401 || upstream.status === 403 || lower.includes("authentication")) {
    return fail(
      401,
      "UNAUTHORIZED",
      "Autentikasi Cloudflare gagal. Pastikan CLOUDFLARE_API_TOKEN valid dan memiliki permission \"Workers AI\", serta CLOUDFLARE_ACCOUNT_ID benar.",
      details,
    );
  }
  if (upstream.status === 429 || lower.includes("neuron") || lower.includes("rate limit") || lower.includes("capacity") || lower.includes("daily free allocation")) {
    return fail(
      429,
      "RATE_LIMITED",
      "Kuota / rate limit Cloudflare Workers AI tercapai (free tier: 10.000 neurons per hari). Tunggu sebentar atau upgrade ke Workers Paid.",
      details,
    );
  }
  if (upstream.status === 400) {
    return fail(400, "UPSTREAM_ERROR", "Cloudflare menolak input (cek ukuran gambar/mask atau prompt).", details);
  }
  return fail(502, "UPSTREAM_ERROR", `Cloudflare Workers AI mengembalikan error (HTTP ${upstream.status}).`, details);
}
