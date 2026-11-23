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

export type GenerationMode = "backplate" | "inpaint" | "harmonized";

export interface ComposeOptions {
  /**
   * backplate : AI menggambar latar kosong -> mobil ditempel + bayangan/pantulan via Canvas.
   * inpaint   : AI sudah menggambar latar di sekitar mobil -> overlay mobil opsional.
   * harmonized: AI merender ulang komposit menjadi satu foto -> detail asli dikembalikan
   *             lewat frequency separation.
   */
  mode: GenerationMode;
  /** Tempel ulang mobil resolusi tinggi (mode inpaint). */
  preserveCar: boolean;
  /** Kekuatan tint warna ambient latar ke bodi mobil (0–0.5). */
  ambientTint: number;
  /** Feather tepi overlay pada resolusi output (px). */
  edgeSoftness: number;
  /** Kekuatan bayangan kontak di bawah mobil/ban (0–1). */
  shadowStrength: number;
  /** Pantulan lingkungan di cat mobil (0–0.6). */
  paintReflection: number;
  /** Pantulan mobil di lantai (lantai mengkilap / aspal basah) (0–0.5). */
  floorReflection: number;
  /** Cocokkan white balance & exposure mobil dengan latar (0–1). */
  colorMatch: number;
  /** Cahaya latar yang "membungkus" tepi mobil (0–1). */
  lightWrap: number;
  /** Samakan ketajaman mobil dengan latar AI (blur px, 0–2). */
  carSoftness: number;
  /** Film grain seragam di seluruh foto (0–1). */
  grain: number;
  /** Vignette lensa (0–1). */
  vignette: number;
  /** Mode harmonized: seberapa banyak detail halus foto asli dikembalikan (0–1). */
  detailRestore: number;
}

function averageBackgroundColor(bg: CanvasImageSource, carLayer: HTMLCanvasElement | null): [number, number, number] {
  const sw = 24, sh = 30;
  const s = createCanvas(sw, sh);
  const sctx = get2d(s, true);
  sctx.drawImage(bg, 0, 0, sw, sh);
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

/** Gambar sumber memenuhi W×H (object-fit: cover). */
function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, W: number, H: number) {
  const iw = (img as HTMLImageElement).naturalWidth || img.width;
  const ih = (img as HTMLImageElement).naturalHeight || img.height;
  const s = Math.max(W / iw, H / ih);
  ctx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
}

/** Blur murah: perkecil lalu perbesar kembali dengan smoothing. */
function cheapBlur(src: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const small = createCanvas(src.width / factor, src.height / factor);
  get2d(small).drawImage(src, 0, 0, small.width, small.height);
  const out = createCanvas(src.width, src.height);
  get2d(out).drawImage(small, 0, 0, out.width, out.height);
  return out;
}

/** Siluet hitam dari layer mobil, di-squash vertikal & di-blur -> bayangan kontak. */
function drawContactShadow(ctx: CanvasRenderingContext2D, carLayer: HTMLCanvasElement, rect: NormRect, W: number, H: number, strength: number) {
  if (strength <= 0) return;
  const cx = rect.x * W, cy = rect.y * H, cw = rect.w * W, ch = rect.h * H;
  const bottom = cy + ch;
  const padX = cw * 0.12;
  const regionW = Math.ceil(cw + padX * 2);
  const regionH = Math.ceil(ch * 0.5);
  const regionY = bottom - regionH * 0.5;

  const layers = [
    // bayangan ambient lebar & lembut dari seluruh siluet
    { srcFrac: 1, height: 0.16, offset: 0.55, sigma: ch * 0.035, alpha: 0.55 },
    // bayangan kontak rapat dari bagian bawah (ban)
    { srcFrac: 0.14, height: 0.045, offset: 0.6, sigma: ch * 0.01, alpha: 0.9 },
  ];

  for (const l of layers) {
    const tmp = createCanvas(regionW, regionH);
    const t = get2d(tmp, true);
    const sy = cy + ch * (1 - l.srcFrac);
    const sh = ch * l.srcFrac;
    const dh = ch * l.height;
    const dy = bottom - regionY - dh * l.offset;
    t.drawImage(carLayer, cx, sy, cw, sh, padX, dy, cw, dh);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = "#000";
    t.fillRect(0, 0, regionW, regionH);
    const data = t.getImageData(0, 0, regionW, regionH);
    const blurred = gaussianBlurChannel(extractAlpha(data), regionW, regionH, Math.max(1, l.sigma));
    for (let i = 0, j = 3; i < blurred.length; i++, j += 4) data.data[j] = blurred[i];
    t.globalCompositeOperation = "source-over";
    t.putImageData(data, 0, 0);
    ctx.save();
    ctx.globalAlpha = Math.min(1, l.alpha * strength);
    ctx.drawImage(tmp, cx - padX, regionY);
    ctx.restore();
  }
}

/** Pantulan mobil di lantai: dicerminkan di garis ban, memudar ke bawah. */
function drawFloorReflection(ctx: CanvasRenderingContext2D, carLayer: HTMLCanvasElement, rect: NormRect, W: number, H: number, amount: number) {
  if (amount <= 0) return;
  const cy = rect.y * H, ch = rect.h * H;
  const bottom = cy + ch;
  const fadeH = ch * 0.45;
  const tmp = createCanvas(W, H);
  const t = get2d(tmp);
  t.save();
  t.translate(0, bottom * 2);
  t.scale(1, -1);
  t.drawImage(carLayer, 0, 0);
  t.restore();
  t.globalCompositeOperation = "destination-in";
  const g = t.createLinearGradient(0, bottom, 0, bottom + fadeH);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  t.fillStyle = g;
  t.fillRect(0, bottom, W, fadeH);
  // buang area di atas garis ban
  t.globalCompositeOperation = "destination-out";
  t.fillRect(0, 0, W, bottom);
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.drawImage(cheapBlur(tmp, 3), 0, 0);
  ctx.restore();
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Bounding box piksel dari rect ternormalisasi (+margin), di-clamp ke kanvas. */
function rectBox(rect: NormRect, W: number, H: number, margin = 0.02) {
  const x0 = Math.max(0, Math.floor((rect.x - margin) * W));
  const y0 = Math.max(0, Math.floor((rect.y - margin) * H));
  const x1 = Math.min(W, Math.ceil((rect.x + rect.w + margin) * W));
  const y1 = Math.min(H, Math.ceil((rect.y + rect.h + margin) * H));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Rata-rata warna berbobot alpha (mobil) dan rata-rata latar di luar mobil. */
function colorStats(bg: HTMLCanvasElement, carShape: HTMLCanvasElement) {
  const sw = 48, sh = 60;
  const read = (src: HTMLCanvasElement) => {
    const c = createCanvas(sw, sh);
    const x = get2d(c, true);
    x.drawImage(src, 0, 0, sw, sh);
    return x.getImageData(0, 0, sw, sh).data;
  };
  const b = read(bg), c = read(carShape);
  const bgM = [0, 0, 0], carM = [0, 0, 0];
  let bn = 0, cn = 0;
  for (let i = 0; i < b.length; i += 4) {
    const ca = c[i + 3] / 255;
    const bw = 1 - ca;
    bgM[0] += b[i] * bw; bgM[1] += b[i + 1] * bw; bgM[2] += b[i + 2] * bw; bn += bw;
    carM[0] += c[i] * ca; carM[1] += c[i + 1] * ca; carM[2] += c[i + 2] * ca; cn += ca;
  }
  return {
    bg: bgM.map((v) => v / Math.max(1e-6, bn)) as [number, number, number],
    car: carM.map((v) => v / Math.max(1e-6, cn)) as [number, number, number],
  };
}

/** Geser white balance & exposure mobil ke arah latar (parsial, agar warna asli tetap terjaga). */
function matchCarColor(car: HTMLCanvasElement, background: HTMLCanvasElement, rect: NormRect, amount: number) {
  if (amount <= 0) return;
  const { bg, car: cm } = colorStats(background, car);
  const lb = Math.max(1, lum(...bg)), lc = Math.max(1, lum(...cm));
  const gains = [0, 1, 2].map((i) => {
    const wb = bg[i] / lb / Math.max(1e-3, cm[i] / lc);
    return clamp(1 + (wb - 1) * amount * 0.6, 0.8, 1.25);
  });
  const expo = 1 + (clamp(lb / lc, 0.7, 1.15) - 1) * amount * 0.5;
  const box = rectBox(rect, car.width, car.height);
  const ctx = get2d(car, true);
  const img = ctx.getImageData(box.x, box.y, box.w, box.h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = d[i] * gains[0] * expo;
    d[i + 1] = d[i + 1] * gains[1] * expo;
    d[i + 2] = d[i + 2] * gains[2] * expo;
  }
  ctx.putImageData(img, box.x, box.y);
}

/** Light wrap: cahaya latar (blur) masuk ke pita tepi bagian dalam mobil, blend screen. */
function drawLightWrap(ctx: CanvasRenderingContext2D, background: HTMLCanvasElement, carShape: HTMLCanvasElement, rect: NormRect, amount: number) {
  if (amount <= 0) return;
  const W = carShape.width, H = carShape.height;
  const box = rectBox(rect, W, H);
  const mask = createCanvas(box.w, box.h);
  const mctx = get2d(mask, true);
  mctx.drawImage(carShape, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const md = mctx.getImageData(0, 0, box.w, box.h);
  const a = extractAlpha(md);
  const inner = gaussianBlurChannel(a, box.w, box.h, Math.max(2, W / 300));
  for (let i = 0, j = 3; i < a.length; i++, j += 4) {
    // pita tepi: ada di dalam mobil (a) tapi jauh dari interior penuh (inner)
    md.data[j] = clamp(a[i] * (1 - inner[i] / 255) * 2.2 * amount, 0, 255);
  }
  mctx.putImageData(md, 0, 0);
  const wrap = createCanvas(box.w, box.h);
  const wctx = get2d(wrap);
  wctx.drawImage(cheapBlur(background, 6), box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  wctx.globalCompositeOperation = "destination-in";
  wctx.drawImage(mask, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.drawImage(wrap, box.x, box.y);
  ctx.restore();
}

/**
 * Frequency separation: ambil cahaya/warna (frekuensi rendah) dari hasil harmonisasi AI,
 * lalu kembalikan tekstur halus (frekuensi tinggi: emblem, tulisan, velg) dari foto asli.
 */
function restoreCarDetail(ctx: CanvasRenderingContext2D, cutout: HTMLCanvasElement, rect: NormRect, W: number, H: number, amount: number) {
  if (amount <= 0) return;
  const box = rectBox(rect, W, H);
  const orig = createCanvas(box.w, box.h);
  const octx = get2d(orig, true);
  octx.drawImage(cutout, rect.x * W - box.x, rect.y * H - box.y, rect.w * W, rect.h * H);
  const O = octx.getImageData(0, 0, box.w, box.h);
  const Himg = ctx.getImageData(box.x, box.y, box.w, box.h);
  const n = box.w * box.h;
  const sigma = Math.max(1.5, W / 420);
  const alpha = extractAlpha(O);
  const soft = gaussianBlurChannel(alpha, box.w, box.h, 2);
  const out = Himg.data;
  for (let c = 0; c < 3; c++) {
    const oc = new Float32Array(n), hc = new Float32Array(n);
    for (let i = 0, j = c; i < n; i++, j += 4) { oc[i] = O.data[j]; hc[i] = Himg.data[j]; }
    const ob = gaussianBlurChannel(oc, box.w, box.h, sigma);
    const hb = gaussianBlurChannel(hc, box.w, box.h, sigma);
    for (let i = 0, j = c; i < n; i++, j += 4) {
      const m = (Math.min(alpha[i], soft[i]) / 255) * amount;
      if (m <= 0) continue;
      const restored = hb[i] + (oc[i] - ob[i]);
      out[j] = hc[i] * (1 - m) + restored * m;
    }
  }
  ctx.putImageData(Himg, box.x, box.y);
}

/** PRNG deterministik agar grain tidak "berkedip" saat preview dirender ulang. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Finishing kamera: vignette + film grain seragam di seluruh foto. */
function cameraFinish(scene: HTMLCanvasElement, grain: number, vignette: number) {
  const W = scene.width, H = scene.height;
  const ctx = get2d(scene, true);
  if (vignette > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${0.5 * vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (grain > 0) {
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const rand = mulberry32(1337);
    const amp = 16 * grain;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() + rand() - 1) * amp; // distribusi segitiga ~ gaussian
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }
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
  const ctx = get2d(scene, true);
  drawCover(ctx, ai, W, H);

  if (opts.mode === "harmonized") {
    restoreCarDetail(ctx, cutout, rect, W, H, opts.detailRestore);
    cameraFinish(scene, opts.grain, opts.vignette);
    return scene;
  }
  if (opts.mode === "inpaint" && !opts.preserveCar) {
    cameraFinish(scene, opts.grain, opts.vignette);
    return scene;
  }

  // Snapshot latar (untuk warna ambient, pantulan & light wrap)
  const background = cloneCanvas(scene);

  // Layer mobil resolusi tinggi dengan tepi di-erode + feather (min(alpha, blur(alpha)))
  const car = createCanvas(W, H);
  const cctx = get2d(car, true);
  drawInRect(cctx, cutout, rect, W, H);
  const data = cctx.getImageData(0, 0, W, H);
  const a = extractAlpha(data);
  const blurred = gaussianBlurChannel(a, W, H, Math.max(0.5, opts.edgeSoftness));
  for (let i = 0, j = 3; i < a.length; i++, j += 4) data.data[j] = Math.min(a[i], blurred[i]);
  cctx.putImageData(data, 0, 0);
  const carShape = cloneCanvas(car);

  // Samakan ketajaman: mobil studio biasanya jauh lebih tajam dari latar AI.
  if (opts.carSoftness > 0 && supportsCanvasFilter()) {
    const tmp = cloneCanvas(car);
    cctx.clearRect(0, 0, W, H);
    cctx.save();
    cctx.filter = `blur(${opts.carSoftness}px)`;
    cctx.drawImage(tmp, 0, 0);
    cctx.restore();
  }

  matchCarColor(car, background, rect, opts.colorMatch);

  // Pantulan lingkungan di cat: latar dicerminkan vertikal + diblur, soft-light di atas bodi.
  if (opts.paintReflection > 0) {
    const env = createCanvas(W, H);
    const e = get2d(env);
    e.translate(0, H);
    e.scale(1, -1);
    e.drawImage(background, 0, 0);
    cctx.save();
    cctx.globalCompositeOperation = "soft-light";
    cctx.globalAlpha = opts.paintReflection;
    cctx.drawImage(cheapBlur(env, 12), 0, 0);
    cctx.restore();
  }

  if (opts.ambientTint > 0) {
    const [r, g, b] = averageBackgroundColor(background, carShape);
    cctx.save();
    cctx.globalCompositeOperation = "soft-light";
    cctx.globalAlpha = opts.ambientTint;
    cctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
    cctx.fillRect(0, 0, W, H);
    cctx.restore();
  }

  // Kembalikan alpha asli mobil (blur/soft-light ikut mewarnai area transparan)
  cctx.save();
  cctx.globalCompositeOperation = "destination-in";
  cctx.drawImage(carShape, 0, 0);
  cctx.restore();

  if (opts.mode === "backplate") {
    drawFloorReflection(ctx, carShape, rect, W, H, opts.floorReflection);
    drawContactShadow(ctx, carShape, rect, W, H, opts.shadowStrength);
  }

  ctx.drawImage(car, 0, 0);
  drawLightWrap(ctx, background, carShape, rect, opts.lightWrap);
  cameraFinish(scene, opts.grain, opts.vignette);
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
