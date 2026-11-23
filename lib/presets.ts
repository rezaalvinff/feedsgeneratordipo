export interface ScenePreset {
  id: string;
  name: string;
  /** Deskripsi singkat (Bahasa Indonesia) untuk kartu preset. */
  description: string;
  /** Deskripsi LOKASI dalam bahasa Inggris (tanpa subjek mobil). */
  scene: string;
  /** Gradien Tailwind untuk thumbnail kartu. */
  swatch: string;
}

/**
 * Booster untuk mode inpainting (mobil ikut ada di gambar yang diproses AI):
 * pantulan lingkungan di cat & bayangan kontak dibuat langsung oleh AI.
 */
export const AUTOMOTIVE_BOOSTER =
  "realistic environment reflections on glossy car paint, soft contact shadows under tires, 35mm lens, photorealistic, professional automotive photography, sharp focus, high detail";

/**
 * Booster untuk mode backplate (AI menggambar latar kosong, mobil ditempel di browser
 * lengkap dengan bayangan kontak & pantulan yang dibuat via Canvas).
 */
export const BACKPLATE_BOOSTER =
  "empty scene with no cars and no vehicles, wide open clear ground in the foreground, low camera at about one meter height, horizon line near the middle of the frame, 35mm lens, photorealistic, professional automotive photography backplate, natural realistic lighting, sharp focus, high detail";

export const DEFAULT_NEGATIVE_PROMPT =
  "cartoon, illustration, painting, drawing, anime, cgi, 3d render, deformed, distorted, blurry, low quality, lowres, jpeg artifacts, watermark, text, logo, signature, oversaturated";

/** Tambahan negative prompt khusus backplate agar AI tidak menggambar kendaraan. */
export const BACKPLATE_NEGATIVE_EXTRA = "car, cars, vehicle, truck, motorcycle, bus, people, crowd";

/** Tambahan negative prompt khusus inpainting. */
export const INPAINT_NEGATIVE_EXTRA = "extra wheels, duplicate car, second car, floating car, people";

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: "jakarta-golden-hour",
    name: "Modern Urban Jakarta (Golden Hour)",
    description: "Jalan aspal modern, gedung kaca, matahari terbenam.",
    scene:
      "a clean modern asphalt street in downtown Jakarta at golden hour, glass skyscrapers in the background, warm low sunlight, long soft shadows",
    swatch: "from-amber-400 via-orange-500 to-rose-700",
  },
  {
    id: "highland-mountain-road",
    name: "Scenic Highland Mountain Road",
    description: "Jalan pegunungan berkabut, alam hijau pagi hari.",
    scene:
      "a winding mountain road in misty highlands at early morning, lush green hills and pine trees, soft fog, gentle diffused sunlight",
    swatch: "from-emerald-300 via-teal-600 to-slate-800",
  },
  {
    id: "luxury-showroom",
    name: "Luxury Minimalist Showroom",
    description: "Lantai beton/marmer, pencahayaan studio arsitektural.",
    scene:
      "the interior of a luxury minimalist car showroom, polished concrete and marble floor, architectural studio lighting, soft overhead light panels, clean grey walls",
    swatch: "from-zinc-200 via-zinc-400 to-zinc-700",
  },
  {
    id: "coastal-sunset-highway",
    name: "Coastal Sunset Highway",
    description: "Jalan pesisir pantai, langit senja dramatis.",
    scene:
      "a coastal highway by the ocean at sunset, dramatic orange and purple sky, calm sea horizon, warm rim light",
    swatch: "from-fuchsia-500 via-orange-400 to-sky-700",
  },
  {
    id: "night-city-street",
    name: "Night City Street",
    description: "Kota malam, aspal basah, pantulan lampu kota.",
    scene:
      "a city street at night, slightly wet asphalt reflecting neon signs and street lights, bokeh city lights, cinematic moody lighting",
    swatch: "from-indigo-500 via-violet-700 to-slate-950",
  },
];

export const CUSTOM_PRESET_ID = "custom";

const clean = (s: string) => s.trim().replace(/[\s,]+$/, "");

/** Prompt latar kosong (mode default). */
export function buildBackplatePrompt(scene: string, useBooster: boolean): string {
  const s = clean(scene);
  if (!useBooster) return s;
  return s ? `${s}, ${BACKPLATE_BOOSTER}` : BACKPLATE_BOOSTER;
}

/** Prompt untuk model inpainting (mobil ada di dalam gambar). */
export function buildInpaintPrompt(scene: string, useBooster: boolean): string {
  const s = clean(scene);
  const base = s ? `a car in ${s}` : "a car";
  return useBooster ? `${base}, ${AUTOMOTIVE_BOOSTER}` : base;
}

export function joinNegative(base: string, extra: string): string {
  const b = clean(base);
  return b ? `${b}, ${extra}` : extra;
}

/**
 * Prompt untuk pass harmonisasi FLUX.2 (gambar referensi = komposit mobil + latar).
 * Tujuannya merender ulang menjadi SATU foto asli tanpa mengubah mobil.
 */
export function buildHarmonizePrompt(scene: string): string {
  const s = clean(scene);
  return [
    "Turn this composite image into one authentic, unedited photograph taken on location.",
    "Keep the exact same car: same make and model, body shape, paint color, wheels, badges, lights, size and position in the frame.",
    "Keep the same background scene, camera angle and framing.",
    s ? `Relight the car so it matches the scene lighting of ${s}.` : "Relight the car so it matches the scene lighting.",
    "Add realistic reflections of the surroundings on the glossy paint and windows, natural contact shadows and ambient occlusion under the tires,",
    "consistent color grading, matching sharpness and natural film grain across the whole image.",
    "Shot on a full-frame DSLR with a 35mm lens, natural light, photorealistic, high detail, no CGI look.",
  ].join(" ");
}
