/* Pipeline komposisi: layout mobil -> input inpainting (image + mask) -> komposit akhir -> framing Instagram. */
import { cloneCanvas, createCanvas, extractAlpha, gaussianBlurChannel, get2d, supportsCanvasFilter } from "./image";

export type Aspect = "4:5" | "1:1";
export type GenQuality = 512 | 768;
export type FitMode = "crop" | "fit";
export type WatermarkPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const OUTPUT_SIZES: Record<Aspect, { width: number; height: number; label: string }> = {
  "4:5": { width: 1080, height: 1350, label: "Feed Portrait 4:5 · 1080×1350" },
  "1:1": { width: 1080, height: 1080, label: "Feed Square 1:1 · 1080×1080" },
};

const round8 = (n: number) => Math.round(n / 8) * 8;

/** Resolusi generasi SD 1.5 (kelipatan 8, rasio sama dengan output). */
export function generationSize(aspect: Aspect, base: GenQuality) {
  return aspect === "4:5" ? { width: base, height: round8(base * 1.25) } : { width: base, height: base };
}

export interface Layout {
  /** Lebar mobil sebagai fraksi lebar frame (0.4–1). */
  scale: number;
  /** Posisi bawah ban sebagai fraksi tinggi frame (0.5–0.98). */
  bottom: number;
  /** Geser horizontal sebagai fraksi lebar frame (-0.3–0.3). */
  offsetX: number;
}

export const DEFAULT_LAYOUT: Layout = { scale: 0.86, bottom: 0.86, offsetX: 0 };

/** Persegi panjang ternormalisasi (0..1) relatif terhadap frame. */
export interface NormRect { x: number; y: number; w: number; h: number }

export function computeCarRect(cutoutW: number, cutoutH: number, aspect: Aspect, layout: Layout): NormRect {
  const { width: W, height: H } = OUTPUT_SIZES[aspect];
  let w = layout.scale * W;
  let h = (w * cutoutH) / cutoutW;
  const maxH = H * 0.82;
  if (h > maxH) {
    h = maxH;
    w = (h * cutoutW) / cutoutH;
  }
  const x = (W - w) / 2 + layout.offsetX * W;
  const y = layout.bottom * H - h;
  return { x: x / W, y: y / H, w: w / W, h: h / H };
}

function drawInRect(ctx: CanvasRenderingContext2D, img: CanvasImageSource, r: NormRect, W: number, H: number) {
  ctx.drawImage(img, r.x * W, r.y * H, r.w * W, r.h * H);
}

export interface InpaintInputs {
  /** Gambar input: mobil di atas latar netral. */
  image: HTMLCanvasElement;
  /** Mask: hitam (#000) = mobil dikunci, putih (#FFF) = latar digambar ulang AI. */
  mask: HTMLCanvasElement;
  rect: NormRect;
  aspect: Aspect;
  width: number;
  height: number;
}

/**
 * Siapkan pasangan image + mask untuk SD 1.5 inpainting.
 * Tepi mask di-feather (gaussian blur `feather` px pada resolusi generasi) agar
 * pantulan & pencahayaan latar baru menyatu dengan bodi mobil.
 */
export function buildInpaintInputs(
  cutout: HTMLCanvasElement,
  aspect: Aspect,
  layout: Layout,
  quality: GenQuality,
  feather: number,
): InpaintInputs {
  const { width, height } = generationSize(aspect, quality);
  const rect = computeCarRect(cutout.width, cutout.height, aspect, layout);

  const image = createCanvas(width, height);
  const ictx = get2d(image);
  ictx.fillStyle = "#7f7f7f";
  ictx.fillRect(0, 0, width, height);
  drawInRect(ictx, cutout, rect, width, height);

  // Silhouette alpha mobil pada resolusi generasi
  const sil = createCanvas(width, height);
  const sctx = get2d(sil, true);
  drawInRect(sctx, cutout, rect, width, height);
  const alpha = gaussianBlurChannel(extractAlpha(sctx.getImageData(0, 0, width, height)), width, height, feather);

  const mask = createCanvas(width, height);
  const mctx = get2d(mask, true);
  const md = mctx.createImageData(width, height);
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    const v = 255 - Math.round(alpha[i]); // mobil = hitam, latar = putih
    md.data[j] = v;
    md.data[j + 1] = v;
    md.data[j + 2] = v;
    md.data[j + 3] = 255;
  }
  mctx.putImageData(md, 0, 0);

  return { image, mask, rect, aspect, width, height };
}

/** Preview komposisi di atas papan catur (sebelum generate). */
export function buildCompositionPreview(cutout: HTMLCanvasElement, aspect: Aspect, layout: Layout): HTMLCanvasElement {
  const { width: W, height: H } = OUTPUT_SIZES[aspect];
  const scale = 0.5;
  const c = createCanvas(W * scale, H * scale);
  const ctx = get2d(c);
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, "#27272a");
  g.addColorStop(1, "#0a0a0b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  // garis horizon/lantai bantu
  const rect = computeCarRect(cutout.width, cutout.height, aspect, layout);
  const floorY = (rect.y + rect.h) * c.height;
  ctx.strokeStyle = "rgba(249,115,22,0.55)";
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(c.width, floorY);
  ctx.stroke();
  ctx.setLineDash([]);
  drawInRect(ctx, cutout, rect, c.width, c.height);
  return c;
}

export interface ComposeOptions {
  /** Tempel ulang mobil resolusi tinggi agar detail tetap tajam (SD menghasilkan 512–768px). */
  preserveCar: boolean;
  /** Kekuatan tint warna ambient latar ke bodi mobil (0–0.5). */
  ambientTint: number;
  /** Feather tepi overlay pada resolusi output (px). */
  edgeSoftness: number;
}

function averageBackgroundColor(ai: CanvasImageSource, carLayer: HTMLCanvasElement | null): [number, number, number] {
  const sw = 24, sh = 30;
  const s = createCanvas(sw, sh);
  const sctx = get2d(s, true);
  sctx.drawImage(ai, 0, 0, sw, sh);
  const d = sctx.getImageData(0, 0, sw, sh).data;
  let carA: Uint8ClampedArray | null = null;
  if (carLayer) {
    const m = createCanvas(sw, sh);
    const mctx = get2d(m, true);
    mctx.drawImage(carLayer, 0, 0, sw, sh);
    carA = mctx.getImageData(0, 0, sw, sh).data;
  }
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const weight = carA ? 1 - carA[i + 3] / 255 : 1;
    r += d[i] * weight; g += d[i + 1] * weight; b += d[i + 2] * weight; n += weight;
  }
  return n > 0 ? [r / n, g / n, b / n] : [128, 128, 128];
}

/** Komposit akhir pada resolusi output (1080 lebar). */
export function composeScene(
  ai: HTMLImageElement | HTMLCanvasElement,
  cutout: HTMLCanvasElement,
  rect: NormRect,
  aspect: Aspect,
  opts: ComposeOptions,
): HTMLCanvasElement {
  const { width: W, height: H } = OUTPUT_SIZES[aspect];
  const scene = createCanvas(W, H);
  const ctx = get2d(scene);
  ctx.drawImage(ai, 0, 0, W, H);
  if (!opts.preserveCar) return scene;

  // Layer mobil resolusi tinggi dengan tepi di-erode + feather (min(alpha, blur(alpha)))
  const car = createCanvas(W, H);
  const cctx = get2d(car, true);
  drawInRect(cctx, cutout, rect, W, H);
  const data = cctx.getImageData(0, 0, W, H);
  const a = extractAlpha(data);
  const blurred = gaussianBlurChannel(a, W, H, Math.max(0.5, opts.edgeSoftness));
  for (let i = 0, j = 3; i < a.length; i++, j += 4) data.data[j] = Math.min(a[i], blurred[i]);
  cctx.putImageData(data, 0, 0);

  if (opts.ambientTint > 0) {
    const [r, g, b] = averageBackgroundColor(ai, car);
    const original = cloneCanvas(car);
    cctx.save();
    cctx.globalCompositeOperation = "soft-light";
    cctx.globalAlpha = opts.ambientTint;
    cctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    cctx.fillRect(0, 0, W, H);
    cctx.globalAlpha = 1;
    cctx.globalCompositeOperation = "destination-in";
    cctx.drawImage(original, 0, 0);
    cctx.restore();
  }

  ctx.drawImage(car, 0, 0);
  return scene;
}

/**
 * Auto-crop / fit hasil ke ukuran feed Instagram.
 * - crop: memenuhi frame, titik fokus vertikal mengikuti posisi mobil.
 * - fit : seluruh gambar terlihat, sisa ruang diisi versi blur dari gambar.
 */
export function frameForInstagram(
  scene: HTMLCanvasElement,
  target: Aspect,
  mode: FitMode,
  focus: { x: number; y: number },
): HTMLCanvasElement {
  const { width: W, height: H } = OUTPUT_SIZES[target];
  const out = createCanvas(W, H);
  const ctx = get2d(out);
  const sw = scene.width, sh = scene.height;

  if (sw * H === sh * W) {
    ctx.drawImage(scene, 0, 0, W, H);
    return out;
  }

  const cover = Math.max(W / sw, H / sh);
  const coverDraw = (fx: number, fy: number) => {
    const dw = sw * cover, dh = sh * cover;
    const dx = Math.min(0, Math.max(W - dw, W / 2 - fx * dw));
    const dy = Math.min(0, Math.max(H - dh, H / 2 - fy * dh));
    ctx.drawImage(scene, dx, dy, dw, dh);
  };

  if (mode === "crop") {
    coverDraw(focus.x, focus.y);
    return out;
  }

  // fit (letterbox dengan latar blur)
  if (supportsCanvasFilter()) {
    ctx.save();
    ctx.filter = "blur(28px) brightness(0.6)";
    coverDraw(0.5, 0.5);
    ctx.restore();
  } else {
    coverDraw(0.5, 0.5);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, W, H);
  }
  const contain = Math.min(W / sw, H / sh);
  const dw = sw * contain, dh = sh * contain;
  ctx.drawImage(scene, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return out;
}

export interface WatermarkOptions {
  position: WatermarkPosition;
  /** Lebar logo sebagai persen lebar gambar. */
  sizePct: number;
  opacity: number;
  marginPct: number;
}

export function applyWatermark(base: HTMLCanvasElement, logo: HTMLImageElement | null, opts: WatermarkOptions): HTMLCanvasElement {
  if (!logo) return base;
  const out = cloneCanvas(base);
  const ctx = get2d(out);
  const lw = (out.width * opts.sizePct) / 100;
  const lh = (lw * logo.naturalHeight) / logo.naturalWidth;
  const m = (out.width * opts.marginPct) / 100;
  const x = opts.position.endsWith("left") ? m : out.width - lw - m;
  const y = opts.position.startsWith("top") ? m : out.height - lh - m;
  ctx.globalAlpha = opts.opacity;
  ctx.drawImage(logo, x, y, lw, lh);
  ctx.globalAlpha = 1;
  return out;
}

export function rectCenter(r: NormRect) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
