"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dropzone, { pickImageFile } from "./Dropzone";
import { Alert, Button, CanvasView, Section, Segmented, Slider, Spinner, Toggle, cx } from "./ui";
import {
  BACKPLATE_BOOSTER,
  BACKPLATE_NEGATIVE_EXTRA,
  CUSTOM_PRESET_ID,
  DEFAULT_NEGATIVE_PROMPT,
  INPAINT_NEGATIVE_EXTRA,
  SCENE_PRESETS,
  buildBackplatePrompt,
  buildHarmonizePrompt,
  buildRealPhotoPrompt,
  buildInpaintPrompt,
  joinNegative,
} from "@/lib/presets";
import { blobToDataURL, canvasToBlob, createCanvas, get2d, hasMeaningfulTransparency, imageToCanvas, loadImage, trimTransparent } from "@/lib/image";
import {
  removeBackgroundInBrowser,
  removeSolidBackground,
  foregroundRatio,
  type SegmentationModel,
  type SegmentationProgress,
} from "@/lib/segmentation";
import {
  DEFAULT_LAYOUT,
  OUTPUT_SIZES,
  applyWatermark,
  buildCompositionPreview,
  buildInpaintInputs,
  composeScene,
  frameForInstagram,
  rectCenter,
  type Aspect,
  type FitMode,
  type GenQuality,
  type GenerationMode,
  type Layout,
  type NormRect,
  type WatermarkPosition,
} from "@/lib/pipeline";

type SegStatus = "idle" | "processing" | "done" | "error";
type SegMethod = "ai" | "solid" | "existing-alpha";

interface OriginalPhoto {
  canvas: HTMLCanvasElement;
  url: string;
  name: string;
}

interface GenResult {
  id: string;
  image: HTMLImageElement;
  rect: NormRect;
  aspect: Aspect;
  seed: number;
  prompt: string;
  model: string;
  mode: GenerationMode;
  /** Untuk hasil harmonisasi: id hasil backplate/inpaint sumbernya. */
  sourceId?: string;
  realism?: Realism;
}

type Realism = "strong" | "subtle";

interface ApiError {
  error?: string;
  code?: string;
  details?: string;
}

const shortModel = (id: string) => id.replace(/^@cf\//, "");

const MAX_SOURCE_DIM = 2048;
const MAX_RESULTS = 6;

const ASPECT_OPTIONS: { value: Aspect; label: string }[] = [
  { value: "4:5", label: "4:5 · 1080×1350" },
  { value: "1:1", label: "1:1 · 1080×1080" },
];

const randomSeed = () => Math.floor(Math.random() * 2_147_483_647);

export default function Studio() {
  // ---------- 1. Upload & masking ----------
  const [original, setOriginal] = useState<OriginalPhoto | null>(null);
  const [cutout, setCutout] = useState<HTMLCanvasElement | null>(null);
  const [segStatus, setSegStatus] = useState<SegStatus>("idle");
  const [segMethod, setSegMethod] = useState<SegMethod | null>(null);
  const [segProgress, setSegProgress] = useState<SegmentationProgress | null>(null);
  const [segError, setSegError] = useState<string | null>(null);
  const [segModel, setSegModel] = useState<SegmentationModel>("isnet_fp16");
  const [solidTolerance, setSolidTolerance] = useState(38);
  const [debugView, setDebugView] = useState(false);
  const jobRef = useRef(0);

  // ---------- 2. Komposisi ----------
  const [aspect, setAspect] = useState<Aspect>("4:5");
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [feather, setFeather] = useState(3.5);
  const [genQuality, setGenQuality] = useState<GenQuality>(512);

  // ---------- 3. Prompt ----------
  const [presetId, setPresetId] = useState<string>(SCENE_PRESETS[0].id);
  const [scene, setScene] = useState<string>(SCENE_PRESETS[0].scene);
  const [useBooster, setUseBooster] = useState(true);
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE_PROMPT);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [steps, setSteps] = useState(20);
  const [guidance, setGuidance] = useState(7.5);
  const [strength, setStrength] = useState(1);
  const [seedLocked, setSeedLocked] = useState(false);
  const [seed, setSeed] = useState<number>(() => 1234567);

  // ---------- 4. Generate ----------
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [genError, setGenError] = useState<ApiError | null>(null);
  const [results, setResults] = useState<GenResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ---------- 5. Framing & export ----------
  const [preserveCar, setPreserveCar] = useState(true);
  const [shadowStrength, setShadowStrength] = useState(0.75);
  const [paintReflection, setPaintReflection] = useState(0.25);
  const [floorReflection, setFloorReflection] = useState(0);
  const [colorMatch, setColorMatch] = useState(0.5);
  const [lightWrap, setLightWrap] = useState(0.35);
  const [carSoftness, setCarSoftness] = useState(0.4);
  const [grain, setGrain] = useState(0.25);
  const [vignette, setVignette] = useState(0.2);
  const [detailRestore, setDetailRestore] = useState(0.7);
  const [realism, setRealism] = useState<Realism>("strong");
  const [busyTask, setBusyTask] = useState<"generate" | "harmonize">("generate");
  const [ambientTint, setAmbientTint] = useState(0.18);
  const [edgeSoftness, setEdgeSoftness] = useState(1.5);
  const [exportAspect, setExportAspect] = useState<Aspect>("4:5");
  const [fitMode, setFitMode] = useState<FitMode>("crop");
  const [exportFormat, setExportFormat] = useState<"jpg" | "png">("jpg");
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  const [wmPosition, setWmPosition] = useState<WatermarkPosition>("top-right");
  const [wmSize, setWmSize] = useState(18);
  const [wmOpacity, setWmOpacity] = useState(0.9);
  const [wmMargin, setWmMargin] = useState(4);

  // Status konfigurasi server (env variables)
  useEffect(() => {
    fetch("/api/generate")
      .then((r) => r.json())
      .then((j: { configured?: boolean }) => setConfigured(Boolean(j.configured)))
      .catch(() => setConfigured(null));
  }, []);

  // Lepas object URL foto lama
  useEffect(() => () => { if (original) URL.revokeObjectURL(original.url); }, [original]);

  // Timer saat generate
  useEffect(() => {
    if (!generating) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [generating]);

  const runAiSegmentation = useCallback(
    async (source: HTMLCanvasElement, model: SegmentationModel) => {
      const job = ++jobRef.current;
      setSegStatus("processing");
      setSegError(null);
      setSegProgress({ stage: "download", label: "Menyiapkan model AI masking…", ratio: null });
      try {
        const cut = await removeBackgroundInBrowser(source, model, (p) => {
          if (jobRef.current === job) setSegProgress(p);
        });
        if (jobRef.current !== job) return;
        const trimmed = trimTransparent(cut);
        if (foregroundRatio(trimmed) < 0.02) throw new Error("Objek mobil tidak terdeteksi dengan jelas.");
        setCutout(trimmed);
        setSegMethod("ai");
        setSegStatus("done");
      } catch (err) {
        if (jobRef.current !== job) return;
        console.error(err);
        setSegStatus("error");
        const raw = err instanceof Error ? err.message : String(err);
        const network = /fetch|network|load/i.test(raw);
        setSegError(
          `${network ? "Model AI masking gagal diunduh dari CDN IMG.LY (staticimgly.com) — cek koneksi / ad-blocker." : raw} ` +
            `Bila foto studio berlatar hitam/putih polos, gunakan fallback "Latar polos" di Opsi masking.`,
        );
      } finally {
        if (jobRef.current === job) setSegProgress(null);
      }
    },
    [],
  );

  const runSolidSegmentation = useCallback((source: HTMLCanvasElement, tolerance: number) => {
    ++jobRef.current;
    try {
      const trimmed = trimTransparent(removeSolidBackground(source, tolerance));
      setCutout(trimmed);
      setSegMethod("solid");
      setSegStatus("done");
      setSegError(null);
    } catch (err) {
      setSegStatus("error");
      setSegError(err instanceof Error ? err.message : "Fallback gagal.");
    }
  }, []);

  const handleCarFile = useCallback(
    async (file: File) => {
      setResults([]);
      setSelectedId(null);
      setGenError(null);
      setCutout(null);
      setSegMethod(null);
      try {
        const url = URL.createObjectURL(file);
        const img = await loadImage(url);
        const canvas = imageToCanvas(img, MAX_SOURCE_DIM);
        setOriginal({ canvas, url, name: file.name });
        if (hasMeaningfulTransparency(canvas)) {
          ++jobRef.current;
          setCutout(trimTransparent(canvas));
          setSegMethod("existing-alpha");
          setSegStatus("done");
          setSegError(null);
          return;
        }
        await runAiSegmentation(canvas, segModel);
      } catch (err) {
        setSegStatus("error");
        setSegError(err instanceof Error ? err.message : "Gagal membaca file gambar.");
      }
    },
    [runAiSegmentation, segModel],
  );

  // Ctrl+V global -> foto mobil
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      const files = Array.from(e.clipboardData?.items ?? []).map((i) => i.getAsFile()).filter((f): f is File => !!f);
      const file = pickImageFile(files);
      if (file) {
        e.preventDefault();
        void handleCarFile(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleCarFile]);

  const handleLogoFile = useCallback(async (file: File) => {
    try {
      setLogo(await loadImage(await blobToDataURL(file)));
    } catch {
      setLogo(null);
    }
  }, []);

  const pasteLogoFromClipboard = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          setLogo(await loadImage(await blobToDataURL(await item.getType(type))));
          return;
        }
      }
      alert("Clipboard tidak berisi gambar.");
    } catch {
      alert("Browser tidak mengizinkan akses clipboard. Klik area logo lalu tekan Ctrl+V / Cmd+V.");
    }
  }, []);

  // ---------- Derived canvases ----------
  const inpaint = useMemo(
    () => (cutout ? buildInpaintInputs(cutout, aspect, layout, genQuality, feather) : null),
    [cutout, aspect, layout, genQuality, feather],
  );
  const compositionPreview = useMemo(
    () => (cutout ? buildCompositionPreview(cutout, aspect, layout) : null),
    [cutout, aspect, layout],
  );

  const selected = results.find((r) => r.id === selectedId) ?? null;

  const composeOpts = useMemo(
    () => ({
      preserveCar,
      ambientTint,
      edgeSoftness,
      shadowStrength,
      paintReflection,
      floorReflection,
      colorMatch,
      lightWrap,
      carSoftness,
      grain,
      vignette,
      detailRestore,
    }),
    [preserveCar, ambientTint, edgeSoftness, shadowStrength, paintReflection, floorReflection, colorMatch, lightWrap, carSoftness, grain, vignette, detailRestore],
  );
  const sceneCanvas = useMemo(
    () =>
      selected && cutout
        ? composeScene(selected.image, cutout, selected.rect, selected.aspect, { ...composeOpts, mode: selected.mode })
        : null,
    [selected, cutout, composeOpts],
  );
  const framed = useMemo(
    () => (sceneCanvas && selected ? frameForInstagram(sceneCanvas, exportAspect, fitMode, rectCenter(selected.rect)) : null),
    [sceneCanvas, selected, exportAspect, fitMode],
  );
  const finalCanvas = useMemo(
    () =>
      framed
        ? applyWatermark(framed, logo, { position: wmPosition, sizePct: wmSize, opacity: wmOpacity, marginPct: wmMargin })
        : null,
    [framed, logo, wmPosition, wmSize, wmOpacity, wmMargin],
  );

  const finalPrompt = buildBackplatePrompt(scene, useBooster);
  const compositionChanged =
    !!selected && !!inpaint && (selected.aspect !== inpaint.aspect || JSON.stringify(selected.rect) !== JSON.stringify(inpaint.rect));

  const selectPreset = (id: string) => {
    setPresetId(id);
    if (id === CUSTOM_PRESET_ID) {
      setScene("");
      return;
    }
    const p = SCENE_PRESETS.find((x) => x.id === id);
    if (p) setScene(p.scene);
  };
  const activePreset = SCENE_PRESETS.find((p) => p.id === presetId);
  const sceneModified = !!activePreset && scene.trim() !== activePreset.scene;

  const changeAspect = (a: Aspect) => {
    setAspect(a);
    setExportAspect(a);
  };

  // ---------- Generate ----------
  const generate = async () => {
    if (!inpaint || generating) return;
    if (!finalPrompt.trim()) {
      setGenError({ error: "Prompt masih kosong. Pilih preset atau tulis deskripsi latar." });
      return;
    }
    const usedSeed = seedLocked ? seed : randomSeed();
    setSeed(usedSeed);
    setBusyTask("generate");
    setGenerating(true);
    setGenError(null);
    const snapshot = inpaint;
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: snapshot.image.toDataURL("image/png"),
          mask: snapshot.mask.toDataURL("image/png"),
          prompt: finalPrompt,
          negative_prompt: joinNegative(negativePrompt, BACKPLATE_NEGATIVE_EXTRA),
          inpaint_prompt: buildInpaintPrompt(scene, useBooster),
          inpaint_negative_prompt: joinNegative(negativePrompt, INPAINT_NEGATIVE_EXTRA),
          aspect: snapshot.aspect,
          quality: genQuality === 768 ? "high" : "standard",
          num_steps: steps,
          guidance,
          strength,
          seed: usedSeed,
        }),
      });
      const json = (await res.json().catch(() => null)) as (ApiError & { image?: string; model?: string; mode?: GenerationMode }) | null;
      if (!res.ok || !json?.image) {
        if (json?.code === "MISSING_ENV") setConfigured(false);
        setGenError(json ?? { error: `Server mengembalikan HTTP ${res.status}.` });
        return;
      }
      if (configured === false) setConfigured(true);
      const image = await loadImage(json.image);
      const result: GenResult = {
        id: `${Date.now()}-${usedSeed}`,
        image,
        rect: snapshot.rect,
        aspect: snapshot.aspect,
        seed: usedSeed,
        prompt: finalPrompt,
        model: json.model ?? "unknown",
        mode: json.mode === "inpaint" ? "inpaint" : "backplate",
      };
      setResults((prev) => [result, ...prev].slice(0, MAX_RESULTS));
      setSelectedId(result.id);
    } catch (err) {
      setGenError({ error: err instanceof Error ? err.message : "Gagal menghubungi server." });
    } finally {
      setGenerating(false);
    }
  };

  // ---------- Harmonisasi AI (FLUX.2 + gambar referensi) ----------
  const harmonizeSource = selected?.mode === "harmonized" ? results.find((r) => r.id === selected.sourceId) ?? null : selected;
  const harmonize = async () => {
    const src = harmonizeSource;
    if (!src || !cutout || generating) return;
    const usedSeed = seedLocked ? seed : randomSeed();
    setSeed(usedSeed);
    setBusyTask("harmonize");
    setGenerating(true);
    setGenError(null);
    try {
      // Komposit tanpa grain/vignette, diperkecil < 512×512 (batas referensi FLUX.2).
      const composite = composeScene(src.image, cutout, src.rect, src.aspect, { ...composeOpts, mode: src.mode, grain: 0, vignette: 0 });
      const refW = src.aspect === "4:5" ? 400 : 496;
      const refH = src.aspect === "4:5" ? 500 : 496;
      const ref = createCanvas(refW, refH);
      get2d(ref).drawImage(composite, 0, 0, refW, refH);
      // Mode kuat: foto mobil asli sebagai referensi ke-2 (identitas model), muat dalam 496px.
      const extraRefs: string[] = [];
      if (realism === "strong") {
        const k = Math.min(496 / cutout.width, 496 / cutout.height);
        const carRef = createCanvas(cutout.width * k + 16, cutout.height * k + 16);
        const cr = get2d(carRef);
        cr.fillStyle = "#808080";
        cr.fillRect(0, 0, carRef.width, carRef.height);
        cr.drawImage(cutout, 8, 8, cutout.width * k, cutout.height * k);
        if (carRef.width > 511 || carRef.height > 511) {
          const s2 = createCanvas(Math.min(511, carRef.width), Math.min(511, carRef.height));
          get2d(s2).drawImage(carRef, 0, 0, s2.width, s2.height);
          extraRefs.push(s2.toDataURL("image/jpeg", 0.92));
        } else {
          extraRefs.push(carRef.toDataURL("image/jpeg", 0.92));
        }
      }
      const harmPrompt = realism === "strong" ? buildRealPhotoPrompt(scene) : buildHarmonizePrompt(scene);
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "harmonize",
          reference_image: ref.toDataURL("image/jpeg", 0.92),
          extra_reference_images: extraRefs,
          prompt: harmPrompt,
          aspect: src.aspect,
          quality: genQuality === 768 ? "high" : "standard",
          seed: usedSeed,
        }),
      });
      const json = (await res.json().catch(() => null)) as (ApiError & { image?: string; model?: string }) | null;
      if (!res.ok || !json?.image) {
        setGenError(json ?? { error: `Server mengembalikan HTTP ${res.status}.` });
        return;
      }
      const image = await loadImage(json.image);
      const result: GenResult = {
        id: `${Date.now()}-h${usedSeed}`,
        image,
        rect: src.rect,
        aspect: src.aspect,
        seed: usedSeed,
        prompt: harmPrompt,
        model: json.model ?? "unknown",
        mode: "harmonized",
        sourceId: src.id,
        realism,
      };
      // Kuat: biarkan mobil hasil AI apa adanya (tekstur CGI asli tidak ditempel ulang).
      setDetailRestore(realism === "strong" ? 0 : 0.7);
      setResults((prev) => [result, ...prev].slice(0, MAX_RESULTS));
      setSelectedId(result.id);
    } catch (err) {
      setGenError({ error: err instanceof Error ? err.message : "Gagal menghubungi server." });
    } finally {
      setGenerating(false);
    }
  };

  // ---------- Download ----------
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (!finalCanvas || !selected) return;
    setDownloading(true);
    try {
      const type = exportFormat === "jpg" ? "image/jpeg" : "image/png";
      const blob = await canvasToBlob(finalCanvas, type, 0.95);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const base = (original?.name ?? "car").replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").slice(0, 40);
      a.href = url;
      a.download = `${base}-feed-${exportAspect.replace(":", "x")}-${selected.seed}.${exportFormat}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } finally {
      setDownloading(false);
    }
  };

  const reset = () => {
    ++jobRef.current;
    setOriginal(null);
    setCutout(null);
    setSegStatus("idle");
    setSegMethod(null);
    setSegError(null);
    setResults([]);
    setSelectedId(null);
    setGenError(null);
  };

  const out = OUTPUT_SIZES[exportAspect];
  const segBusy = segStatus === "processing";

  return (
    <div className="min-h-dvh bg-[radial-gradient(ellipse_at_top,rgba(249,115,22,0.08),transparent_55%)]">
      {/* Header */}
      <header className="border-b border-zinc-800/70 bg-zinc-950/70 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-accent-400 to-accent-600 shadow-lg shadow-accent-500/20">
              <svg viewBox="0 0 24 24" className="size-5 text-zinc-950" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 17h14M3 13l2-5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 8l2 5v4h-2" />
                <circle cx="7.5" cy="17" r="1.8" />
                <circle cx="16.5" cy="17" r="1.8" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide text-zinc-50 sm:text-base">Automotive Feeds Generator</h1>
              <p className="text-[11px] text-zinc-500 sm:text-xs">Foto studio katalog → foto komersial Instagram Feed</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
                configured === true && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                configured === false && "border-red-500/30 bg-red-500/10 text-red-300",
                configured === null && "border-zinc-700 bg-zinc-900 text-zinc-400",
              )}
            >
              <span
                className={cx(
                  "size-1.5 rounded-full",
                  configured === true ? "bg-emerald-400" : configured === false ? "bg-red-400" : "bg-zinc-500",
                )}
              />
              {configured === true ? "Cloudflare AI terhubung" : configured === false ? "Env Cloudflare belum diisi" : "Memeriksa konfigurasi…"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* ---------------- Kolom kontrol ---------------- */}
        <div className="space-y-4">
          {configured === false && (
            <Alert tone="warning" title="CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN belum diisi">
              Salin <code className="rounded bg-black/30 px-1">.env.example</code> ke{" "}
              <code className="rounded bg-black/30 px-1">.env.local</code>, isi kredensial, lalu restart{" "}
              <code className="rounded bg-black/30 px-1">npm run dev</code>. Di Vercel: Project Settings → Environment Variables → Redeploy.
              Upload & masking tetap bisa dicoba.
            </Alert>
          )}

          {/* 1. Upload */}
          <Section
            step={1}
            title="Upload & Auto-Masking"
            subtitle="Foto mobil katalog (PNG/JPG) berlatar polos/hitam. Latar dihapus langsung di browser."
            aside={
              original && (
                <Button variant="ghost" onClick={reset}>
                  Ganti foto
                </Button>
              )
            }
          >
            {!original ? (
              <Dropzone onFile={handleCarFile}>
                <svg viewBox="0 0 24 24" className="mb-3 size-8 text-zinc-500 group-hover:text-accent-400" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p className="text-sm font-medium text-zinc-200">Tarik & lepas foto mobil di sini</p>
                <p className="mt-1 text-xs text-zinc-500">atau klik untuk memilih · bisa juga Ctrl+V · PNG / JPG / WEBP</p>
              </Dropzone>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={original.url} alt="Foto asli" className="size-14 rounded-lg bg-black object-contain" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-zinc-200">{original.name}</p>
                    <p className="text-[11px] text-zinc-500">
                      {original.canvas.width}×{original.canvas.height}px
                      {segMethod === "ai" && " · masking AI (IMG.LY)"}
                      {segMethod === "solid" && " · masking latar polos"}
                      {segMethod === "existing-alpha" && " · PNG transparan terdeteksi"}
                    </p>
                  </div>
                  {segStatus === "done" && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Siap</span>}
                </div>

                {segBusy && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs text-zinc-300">
                      <Spinner className="text-accent-400" />
                      {segProgress?.label ?? "Memproses…"}
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className={cx("h-full rounded-full bg-accent-500 transition-all", segProgress?.ratio == null && "w-1/3 animate-pulse")}
                        style={segProgress?.ratio != null ? { width: `${Math.round(segProgress.ratio * 100)}%` } : undefined}
                      />
                    </div>
                  </div>
                )}

                {segError && <Alert title="Masking gagal">{segError}</Alert>}

                {!segBusy && (
                  <details className="group rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs" open={segStatus === "error"}>
                    <summary className="cursor-pointer select-none text-zinc-400 hover:text-zinc-200">Opsi masking</summary>
                    <div className="mt-3 space-y-3 pb-1">
                      <div>
                        <p className="mb-1.5 text-zinc-400">Model AI (IMG.LY)</p>
                        <Segmented<SegmentationModel>
                          size="sm"
                          value={segModel}
                          onChange={setSegModel}
                          options={[
                            { value: "isnet_quint8", label: "Cepat" },
                            { value: "isnet_fp16", label: "Seimbang" },
                            { value: "isnet", label: "Terbaik" },
                          ]}
                        />
                        <Button className="mt-2 w-full" onClick={() => runAiSegmentation(original.canvas, segModel)}>
                          Jalankan ulang masking AI
                        </Button>
                      </div>
                      <div className="border-t border-zinc-800 pt-3">
                        <Slider label="Fallback latar polos · toleransi warna" value={solidTolerance} min={8} max={120} onChange={setSolidTolerance} />
                        <Button className="mt-2 w-full" onClick={() => runSolidSegmentation(original.canvas, solidTolerance)}>
                          Gunakan fallback latar polos
                        </Button>
                      </div>
                    </div>
                  </details>
                )}

                <Toggle
                  label="Debug view"
                  description="Tampilkan hasil isolasi mobil, mask hitam-putih, dan input yang dikirim ke AI."
                  checked={debugView}
                  onChange={setDebugView}
                />
              </div>
            )}
          </Section>

          {/* 2. Komposisi */}
          <Section step={2} title="Komposisi & Mask" subtitle="Atur posisi mobil di frame. Area putih pada mask akan digambar ulang oleh AI." disabled={!cutout}>
            <div className="space-y-4">
              <div>
                <p className="mb-1.5 text-xs text-zinc-400">Rasio frame</p>
                <Segmented<Aspect> value={aspect} onChange={changeAspect} options={ASPECT_OPTIONS} />
              </div>
              <Slider label="Ukuran mobil" value={layout.scale} min={0.4} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setLayout((l) => ({ ...l, scale: v }))} />
              <Slider label="Posisi vertikal (garis ban)" value={layout.bottom} min={0.5} max={0.98} step={0.005} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setLayout((l) => ({ ...l, bottom: v }))} />
              <Slider label="Geser horizontal" value={layout.offsetX} min={-0.3} max={0.3} step={0.005} format={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`} onChange={(v) => setLayout((l) => ({ ...l, offsetX: v }))} />
              <Slider label="Feather tepi mask" value={feather} min={0} max={8} step={0.5} format={(v) => `${v}px`} onChange={setFeather} />
              <div>
                <p className="mb-1.5 text-xs text-zinc-400">Resolusi generasi AI</p>
                <Segmented<GenQuality>
                  value={genQuality}
                  onChange={setGenQuality}
                  options={[
                    { value: 512, label: "Standar · cepat" },
                    { value: 768, label: "Tinggi · detail" },
                  ]}
                />
              </div>
              <Button variant="ghost" onClick={() => { setLayout(DEFAULT_LAYOUT); setFeather(3.5); }}>
                Reset komposisi
              </Button>
            </div>
          </Section>

          {/* 3. Prompt */}
          <Section step={3} title="Latar Belakang & Prompt" subtitle="Preset dioptimasi untuk fotografi otomotif realistis." disabled={!cutout}>
            <div className="grid grid-cols-2 gap-2">
              {SCENE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => selectPreset(p.id)}
                  className={cx(
                    "group overflow-hidden rounded-xl border text-left transition-all",
                    presetId === p.id ? "border-accent-500 ring-1 ring-accent-500/50" : "border-zinc-800 hover:border-zinc-600",
                  )}
                >
                  <div className={cx("h-10 bg-gradient-to-br", p.swatch)} />
                  <div className="bg-zinc-950/70 p-2">
                    <p className="text-[11px] font-semibold leading-tight text-zinc-100">{p.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-zinc-500">{p.description}</p>
                  </div>
                </button>
              ))}
              <button
                type="button"
                onClick={() => selectPreset(CUSTOM_PRESET_ID)}
                className={cx(
                  "flex flex-col items-center justify-center rounded-xl border border-dashed p-2 text-center transition-all",
                  presetId === CUSTOM_PRESET_ID ? "border-accent-500 bg-accent-500/5" : "border-zinc-700 hover:border-zinc-500",
                )}
              >
                <span className="text-lg leading-none text-zinc-400">✎</span>
                <span className="mt-1 text-[11px] font-semibold text-zinc-200">Custom Prompt</span>
                <span className="text-[10px] text-zinc-500">Tulis sendiri</span>
              </button>
            </div>

            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="scene" className="text-xs text-zinc-400">
                  Deskripsi lokasi (English, tanpa mobil)
                  {sceneModified && <span className="ml-2 rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] text-accent-300">dimodifikasi</span>}
                </label>
                {sceneModified && activePreset && (
                  <Button variant="ghost" onClick={() => setScene(activePreset.scene)}>
                    Reset preset
                  </Button>
                )}
              </div>
              <textarea
                id="scene"
                rows={4}
                value={scene}
                onChange={(e) => setScene(e.target.value)}
                placeholder="e.g. the driveway of a modern villa in Bali, tropical palm trees, bright daylight"
                className="w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-accent-500/60 focus:outline-none"
              />
            </div>

            <div className="mt-3">
              <Toggle
                label="Booster fotografi otomotif"
                description={BACKPLATE_BOOSTER}
                checked={useBooster}
                onChange={setUseBooster}
              />
            </div>

            <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="mt-4 text-xs text-zinc-400 hover:text-zinc-200">
              {showAdvanced ? "▾" : "▸"} Pengaturan lanjutan
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
                <div>
                  <label htmlFor="neg" className="mb-1.5 block text-xs text-zinc-400">
                    Negative prompt
                  </label>
                  <textarea
                    id="neg"
                    rows={3}
                    value={negativePrompt}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                    className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-[11px] leading-relaxed text-zinc-300 focus:border-accent-500/60 focus:outline-none"
                  />
                </div>
                <Slider label="Steps" value={steps} min={5} max={20} onChange={setSteps} />
                <Slider label="Guidance (CFG)" value={guidance} min={1} max={15} step={0.5} onChange={setGuidance} />
                <Slider label="Strength" value={strength} min={0.3} max={1} step={0.05} onChange={setStrength} />
                <div className="flex items-end gap-2">
                  <label className="flex-1">
                    <span className="mb-1.5 block text-xs text-zinc-400">Seed</span>
                    <input
                      type="number"
                      value={seed}
                      min={0}
                      onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-xs tabular-nums text-zinc-100 focus:border-accent-500/60 focus:outline-none"
                    />
                  </label>
                  <Button onClick={() => setSeedLocked((v) => !v)} className={cx(seedLocked && "border-accent-500/60 text-accent-300")}>
                    {seedLocked ? "🔒 Terkunci" : "🎲 Acak"}
                  </Button>
                </div>
              </div>
            )}
          </Section>

          {/* 4. Generate */}
          <Section step={4} title="Generate" subtitle="Cloudflare Workers AI · model aktif dipilih otomatis" disabled={!cutout}>
            <Button variant="primary" className="w-full py-3" onClick={generate} disabled={!inpaint || generating}>
              {generating && busyTask === "generate" ? (
                <>
                  <Spinner /> Menggambar latar… {elapsed}s
                </>
              ) : results.length ? (
                "Generate variasi baru"
              ) : (
                "Generate foto komersial"
              )}
            </Button>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              <span className="text-zinc-400">Prompt final:</span> {finalPrompt || "—"}
            </p>
            {selected && (
              <p className="mt-1 text-[11px] text-zinc-500">
                <span className="text-zinc-400">Model terpakai:</span> {shortModel(selected.model)} ·{" "}
                {selected.mode === "inpaint"
                  ? "inpainting"
                  : selected.mode === "harmonized"
                    ? `harmonisasi AI (${selected.realism === "strong" ? "kuat, mobil dirender ulang" : "halus + detail asli"})`
                    : "backplate + komposit Canvas"}{" "}
                · seed {selected.seed}
              </p>
            )}
            {harmonizeSource && (
              <div className="mt-4 rounded-xl border border-accent-500/30 bg-accent-500/5 p-3">
                <p className="text-xs font-semibold text-zinc-100">✨ Harmonisasi AI: jadikan foto asli</p>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                  Komposit dikirim ke FLUX.2 untuk dirender ulang menjadi satu foto asli. Pakai 1× kuota generate lagi.
                </p>
                <div className="mt-3">
                  <Segmented<Realism>
                    size="sm"
                    value={realism}
                    onChange={setRealism}
                    options={[
                      { value: "strong", label: "Kuat · mobil dirender ulang" },
                      { value: "subtle", label: "Halus · jaga detail asli" },
                    ]}
                  />
                  <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">
                    {realism === "strong"
                      ? "Paling seperti foto asli. Cocok untuk foto katalog render 3D/CGI. Detail kecil (tulisan emblem, plat) bisa sedikit berubah."
                      : "Hanya menyesuaikan cahaya & warna. Mobil hampir identik dengan foto asli, termasuk tampilan CGI-nya."}
                  </p>
                </div>
                <Button className="mt-3 w-full border-accent-500/50" onClick={harmonize} disabled={generating}>
                  {generating && busyTask === "harmonize" ? (
                    <>
                      <Spinner /> Merender ulang jadi foto… {elapsed}s
                    </>
                  ) : selected?.mode === "harmonized" ? (
                    "Harmonisasi ulang (variasi lain)"
                  ) : (
                    "Harmonisasi AI"
                  )}
                </Button>
              </div>
            )}
            {compositionChanged && !generating && (
              <div className="mt-3">
                <Alert tone="info" title="Komposisi berubah">
                  Hasil yang tampil memakai komposisi sebelumnya. Generate ulang untuk menerapkan posisi/rasio baru.
                </Alert>
              </div>
            )}
            {genError && (
              <div className="mt-3">
                <Alert title={genError.code ? `Gagal generate (${genError.code})` : "Gagal generate"}>
                  <p>{genError.error}</p>
                  {genError.details && <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] opacity-75">{genError.details}</p>}
                </Alert>
              </div>
            )}
          </Section>
        </div>

        {/* ---------------- Kolom preview ---------------- */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-100">{selected ? "Before vs After" : "Preview"}</h2>
              {finalCanvas && (
                <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-[11px] text-zinc-400">
                  {out.width}×{out.height}px
                </span>
              )}
            </div>

            {!original && (
              <div className="grid aspect-[4/5] max-h-[70vh] w-full place-items-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 text-center">
                <div className="px-6">
                  <p className="text-sm text-zinc-300">Belum ada foto</p>
                  <p className="mt-1 text-xs text-zinc-500">Upload foto studio mobil untuk memulai.</p>
                </div>
              </div>
            )}

            {original && !selected && (
              <div className="mx-auto max-w-md">
                <div className="relative overflow-hidden rounded-xl border border-zinc-800">
                  {compositionPreview ? (
                    <CanvasView canvas={compositionPreview} label="Preview komposisi" />
                  ) : (
                    <div className={cx("grid place-items-center bg-black", aspect === "4:5" ? "aspect-[4/5]" : "aspect-square")}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={original.url} alt="Foto asli" className={cx("max-h-full w-full object-contain", segBusy && "opacity-50")} />
                      {segBusy && (
                        <div className="absolute inset-0 grid place-items-center">
                          <Spinner className="size-8 text-accent-400" />
                        </div>
                      )}
                    </div>
                  )}
                  {generating && (
                    <div className="absolute inset-0 grid place-items-center bg-zinc-950/60 backdrop-blur-[2px]">
                      <div className="flex items-center gap-2 text-sm text-zinc-200">
                        <Spinner className="text-accent-400" /> AI sedang menggambar latar… {elapsed}s
                      </div>
                    </div>
                  )}
                </div>
                <p className="mt-2 text-center text-[11px] text-zinc-500">
                  {cutout ? "Komposisi — garis putus-putus = garis kontak ban dengan lantai." : "Menunggu hasil masking…"}
                </p>
              </div>
            )}

            {selected && original && (
              <div className="grid grid-cols-2 gap-3">
                <figure>
                  <div className={cx("grid place-items-center overflow-hidden rounded-xl border border-zinc-800 bg-black", exportAspect === "4:5" ? "aspect-[4/5]" : "aspect-square")}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={original.url} alt="Before" className="max-h-full w-full object-contain" />
                  </div>
                  <figcaption className="mt-1.5 text-center text-[11px] font-medium uppercase tracking-wider text-zinc-500">Before</figcaption>
                </figure>
                <figure>
                  <div className="relative overflow-hidden rounded-xl border border-zinc-800">
                    <CanvasView canvas={finalCanvas} label="After" />
                    {generating && (
                      <div className="absolute inset-0 grid place-items-center bg-zinc-950/60 backdrop-blur-[2px]">
                        <Spinner className="size-6 text-accent-400" />
                      </div>
                    )}
                  </div>
                  <figcaption className="mt-1.5 text-center text-[11px] font-medium uppercase tracking-wider text-accent-400">After</figcaption>
                </figure>
              </div>
            )}

            {results.length > 1 && (
              <div className="mt-4">
                <p className="mb-2 text-xs text-zinc-400">Variasi ({results.length})</p>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      title={`Seed ${r.seed}`}
                      className={cx(
                        "w-16 shrink-0 overflow-hidden rounded-lg border transition-all",
                        r.id === selectedId ? "border-accent-500 ring-1 ring-accent-500/50" : "border-zinc-800 opacity-70 hover:opacity-100",
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={r.image.src} alt={`Variasi seed ${r.seed}`} className="block w-full" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {debugView && cutout && inpaint && (
              <div className="mt-5 border-t border-zinc-800 pt-4">
                <p className="mb-2 text-xs font-medium text-zinc-300">Debug view</p>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: "Isolasi mobil", canvas: cutout, checker: true },
                    { label: `Mask ${inpaint.width}×${inpaint.height}`, canvas: inpaint.mask },
                    { label: "Input ke AI", canvas: inpaint.image },
                  ].map((t) => (
                    <figure key={t.label}>
                      <div className={cx("grid min-h-20 place-items-center overflow-hidden rounded-lg border border-zinc-800", t.checker && "checkerboard")}>
                        <CanvasView canvas={t.canvas} label={t.label} />
                      </div>
                      <figcaption className="mt-1 text-center text-[10px] text-zinc-500">{t.label}</figcaption>
                    </figure>
                  ))}
                </div>
                {selected && (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <figure>
                      <div className="overflow-hidden rounded-lg border border-zinc-800">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={selected.image.src} alt="Output mentah AI" className="block w-full" />
                      </div>
                      <figcaption className="mt-1 text-center text-[10px] text-zinc-500">
                        Output mentah AI {selected.image.naturalWidth}×{selected.image.naturalHeight}
                      </figcaption>
                    </figure>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 5. Framing & Export */}
          <Section step={5} title="Framing & Export" subtitle="Auto-crop / fit ke ukuran Instagram, tambahkan logo, lalu unduh." disabled={!selected}>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <p className="mb-1.5 text-xs text-zinc-400">Ukuran output</p>
                  <Segmented<Aspect> value={exportAspect} onChange={setExportAspect} options={ASPECT_OPTIONS} />
                </div>
                <div>
                  <p className="mb-1.5 text-xs text-zinc-400">Mode framing {selected && selected.aspect === exportAspect && <span className="text-zinc-600">(rasio sudah sesuai)</span>}</p>
                  <Segmented<FitMode>
                    value={fitMode}
                    onChange={setFitMode}
                    options={[
                      { value: "crop", label: "Auto-Crop (fokus mobil)" },
                      { value: "fit", label: "Fit (latar blur)" },
                    ]}
                  />
                </div>
                {selected?.mode === "inpaint" && (
                  <Toggle
                    label="Pertahankan detail mobil (high-res)"
                    description="Tempel ulang mobil resolusi asli di atas hasil AI agar emblem, velg & lampu tetap tajam."
                    checked={preserveCar}
                    onChange={setPreserveCar}
                  />
                )}
                {selected?.mode === "harmonized" && (
                  <Slider
                    label="Kembalikan detail asli (emblem, velg, tulisan)"
                    value={detailRestore}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={setDetailRestore}
                  />
                )}
                {selected?.mode === "harmonized" && (
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    0% = mobil murni hasil AI (paling natural). Naikkan bila emblem/tulisan berubah. Bila muncul garis ganda, turunkan lagi.
                  </p>
                )}
                {selected?.mode !== "harmonized" && (selected?.mode !== "inpaint" || preserveCar) && (
                  <>
                    <p className="text-xs font-medium text-zinc-200">Integrasi mobil ke latar</p>
                    <Slider label="Cocokkan warna & cahaya" value={colorMatch} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setColorMatch} />
                    <Slider label="Light wrap (cahaya di tepi mobil)" value={lightWrap} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setLightWrap} />
                    <Slider label="Samakan ketajaman" value={carSoftness} min={0} max={2} step={0.1} format={(v) => `${v.toFixed(1)}px`} onChange={setCarSoftness} />
                    {selected?.mode !== "inpaint" && (
                      <>
                        <Slider label="Bayangan kontak ban" value={shadowStrength} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setShadowStrength} />
                        <Slider label="Pantulan lantai (showroom / aspal basah)" value={floorReflection} min={0} max={0.5} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setFloorReflection} />
                      </>
                    )}
                    <Slider label="Pantulan lingkungan di cat" value={paintReflection} min={0} max={0.6} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setPaintReflection} />
                    <Slider label="Ambient color blend" value={ambientTint} min={0} max={0.5} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setAmbientTint} />
                    <Slider label="Kelembutan tepi mobil" value={edgeSoftness} min={0.5} max={5} step={0.25} format={(v) => `${v}px`} onChange={setEdgeSoftness} />
                  </>
                )}
                <p className="text-xs font-medium text-zinc-200">Finishing kamera</p>
                <Slider label="Film grain" value={grain} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setGrain} />
                <Slider label="Vignette" value={vignette} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setVignette} />
              </div>

              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="text-xs text-zinc-400">Logo watermark (opsional)</p>
                    {logo ? (
                      <Button variant="ghost" onClick={() => setLogo(null)}>
                        Hapus
                      </Button>
                    ) : (
                      <Button variant="ghost" onClick={pasteLogoFromClipboard}>
                        Tempel dari clipboard
                      </Button>
                    )}
                  </div>
                  <Dropzone onFile={handleLogoFile} compact pasteTarget>
                    {logo ? (
                      <div className="checkerboard grid h-12 w-full place-items-center rounded-lg">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={logo.src} alt="Logo" className="max-h-10 max-w-[80%] object-contain" />
                      </div>
                    ) : (
                      <p className="text-[11px] text-zinc-500">Klik / drop PNG logo transparan · fokus lalu Ctrl+V</p>
                    )}
                  </Dropzone>
                </div>
                {logo && (
                  <>
                    <Segmented<WatermarkPosition>
                      size="sm"
                      value={wmPosition}
                      onChange={setWmPosition}
                      options={[
                        { value: "top-left", label: "↖ Kiri atas" },
                        { value: "top-right", label: "↗ Kanan atas" },
                        { value: "bottom-left", label: "↙ Kiri bawah" },
                        { value: "bottom-right", label: "↘ Kanan bawah" },
                      ]}
                    />
                    <Slider label="Ukuran logo" value={wmSize} min={5} max={45} format={(v) => `${v}%`} onChange={setWmSize} />
                    <Slider label="Opacity" value={wmOpacity} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setWmOpacity} />
                    <Slider label="Margin" value={wmMargin} min={0} max={12} step={0.5} format={(v) => `${v}%`} onChange={setWmMargin} />
                  </>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-2 border-t border-zinc-800 pt-4 sm:flex-row sm:items-center">
              <div className="sm:w-40">
                <Segmented<"jpg" | "png">
                  value={exportFormat}
                  onChange={setExportFormat}
                  options={[
                    { value: "jpg", label: "JPG" },
                    { value: "png", label: "PNG" },
                  ]}
                />
              </div>
              <Button variant="primary" className="flex-1" onClick={download} disabled={!finalCanvas || downloading}>
                {downloading ? <Spinner /> : (
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 4v12m0 0-4-4m4 4 4-4M4 20h16" />
                  </svg>
                )}
                Download High-Res {exportFormat.toUpperCase()} · {out.width}×{out.height}
              </Button>
            </div>
          </Section>
        </div>
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 pt-2 text-[11px] text-zinc-600 sm:px-6">
        Masking berjalan di browser (IMG.LY background-removal, ONNX/WASM). Generasi latar via Cloudflare Workers AI. Foto tidak disimpan di server.
      </footer>
    </div>
  );
}
