/* Isolasi objek mobil di browser (tanpa membebani serverless function). */
import { canvasToBlob, createCanvas, extractAlpha, gaussianBlurChannel, get2d, loadImageFromBlob, imageToCanvas } from "./image";

export type SegmentationModel = "isnet" | "isnet_fp16" | "isnet_quint8";

export interface SegmentationProgress {
  stage: "download" | "compute";
  label: string;
  /** 0..1, atau null bila tidak diketahui */
  ratio: number | null;
}

/**
 * Hapus background menggunakan @imgly/background-removal (ONNX/WASM di browser).
 * Model (~40–170MB tergantung varian) diunduh sekali lalu di-cache oleh browser.
 */
export async function removeBackgroundInBrowser(
  source: HTMLCanvasElement,
  model: SegmentationModel,
  onProgress?: (p: SegmentationProgress) => void,
): Promise<HTMLCanvasElement> {
  const { removeBackground } = await import("@imgly/background-removal");
  const input = await canvasToBlob(source, "image/png");
  const result = await removeBackground(input, {
    model,
    output: { format: "image/png", quality: 1 },
    progress: (key: string, current: number, total: number) => {
      const isFetch = key.startsWith("fetch");
      onProgress?.({
        stage: isFetch ? "download" : "compute",
        label: isFetch ? "Mengunduh model AI masking (sekali saja)…" : "Memisahkan mobil dari latar…",
        ratio: total > 0 ? Math.min(1, current / total) : null,
      });
    },
  });
  const img = await loadImageFromBlob(result);
  return imageToCanvas(img);
}

/**
 * Fallback sederhana untuk foto studio berlatar polos (hitam/putih/abu):
 * flood-fill dari tepi gambar berdasarkan kemiripan warna dengan latar.
 * Berguna bila model AI gagal diunduh (mis. jaringan memblokir CDN).
 */
export function removeSolidBackground(source: HTMLCanvasElement, tolerance = 38): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const out = createCanvas(w, h);
  const ctx = get2d(out, true);
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // Warna latar = median piksel di sepanjang tepi.
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
  };
  const step = Math.max(1, Math.floor(Math.min(w, h) / 200));
  for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
  const median = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  const br = median(rs), bg = median(gs), bb = median(bs);

  const tol2 = tolerance * tolerance;
  const isBg = (i: number) => {
    const dr = d[i] - br, dg = d[i + 1] - bg, db = d[i + 2] - bb;
    return dr * dr + dg * dg + db * db <= tol2;
  };

  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (p: number) => {
    if (!visited[p] && isBg(p * 4)) { visited[p] = 1; stack[sp++] = p; }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }

  // Alpha biner lalu dihaluskan tipis agar tepi tidak bergerigi.
  const alpha = new Float32Array(w * h);
  for (let p = 0; p < alpha.length; p++) alpha[p] = visited[p] ? 0 : 255;
  const soft = gaussianBlurChannel(alpha, w, h, 0.8);
  for (let p = 0, j = 3; p < soft.length; p++, j += 4) d[j] = Math.min(d[j], soft[p]);
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Persentase piksel yang tersisa sebagai objek (untuk validasi hasil). */
export function foregroundRatio(cutout: HTMLCanvasElement): number {
  const a = extractAlpha(get2d(cutout, true).getImageData(0, 0, cutout.width, cutout.height));
  let fg = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > 127) fg++;
  return fg / a.length;
}
