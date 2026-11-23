/* Utilitas HTML5 Canvas (hanya berjalan di browser). */

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export function get2d(canvas: HTMLCanvasElement, willReadFrequently = false): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently });
  if (!ctx) throw new Error("Browser tidak mendukung Canvas 2D.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Gagal memuat gambar."));
    img.src = src;
  });
}

export async function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    // Gambar sudah ter-decode; URL boleh dilepas.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Gambar sumber ke canvas, diperkecil bila sisi terpanjang > maxDim. */
export function imageToCanvas(img: CanvasImageSource & { width: number; height: number }, maxDim = Infinity): HTMLCanvasElement {
  const w = (img as HTMLImageElement).naturalWidth || img.width;
  const h = (img as HTMLImageElement).naturalHeight || img.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const c = createCanvas(w * scale, h * scale);
  get2d(c).drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Gagal mengekspor canvas."))), type, quality);
  });
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  get2d(c).drawImage(src, 0, 0);
  return c;
}

/** Ambil channel alpha sebagai Float32Array (0..255). */
export function extractAlpha(data: ImageData): Float32Array {
  const out = new Float32Array(data.width * data.height);
  const d = data.data;
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

/** True jika gambar memiliki area transparan yang signifikan (sudah berupa cutout). */
export function hasMeaningfulTransparency(canvas: HTMLCanvasElement, minRatio = 0.02): boolean {
  const ctx = get2d(canvas, true);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let transparent = 0;
  const total = canvas.width * canvas.height;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 10) transparent++;
  return transparent / total >= minRatio;
}

/** Crop canvas ke bounding box piksel yang tidak transparan. */
export function trimTransparent(canvas: HTMLCanvasElement, threshold = 8, padding = 2): HTMLCanvasElement {
  const { width: w, height: h } = canvas;
  const { data } = get2d(canvas, true).getImageData(0, 0, w, h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("Objek mobil tidak terdeteksi pada foto.");
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(w - 1, maxX + padding);
  maxY = Math.min(h - 1, maxY + padding);
  const out = createCanvas(maxX - minX + 1, maxY - minY + 1);
  get2d(out).drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const div = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / div;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const div = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / div;
      sum += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

/**
 * Blur gaussian (aproksimasi 3x box blur) pada satu channel.
 * `sigma` kira-kira setara dengan CSS `blur(<sigma>px)`; tidak bergantung pada
 * dukungan `ctx.filter` sehingga konsisten di semua browser (termasuk Safari lama).
 */
export function gaussianBlurChannel(data: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.25) return data.slice();
  // 3 pass box blur dengan lebar (2r+1): sigma^2 = 3 * ((2r+1)^2 - 1) / 12
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const a = data.slice();
  const tmp = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(a, tmp, w, h, r);
    boxBlurV(tmp, a, w, h, r);
  }
  return a;
}

/** Fitur `ctx.filter` (dipakai hanya untuk efek dekoratif, ada fallback). */
export function supportsCanvasFilter(): boolean {
  try {
    const ctx = createCanvas(1, 1).getContext("2d");
    if (!ctx || !("filter" in ctx)) return false;
    ctx.filter = "blur(2px)";
    return ctx.filter === "blur(2px)";
  } catch {
    return false;
  }
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Gagal membaca file."));
    r.readAsDataURL(blob);
  });
}
