export interface ScenePreset {
  id: string;
  name: string;
  /** Deskripsi singkat (Bahasa Indonesia) untuk kartu preset. */
  description: string;
  /** Deskripsi scene dalam bahasa Inggris (bagian awal prompt). */
  scene: string;
  /** Gradien Tailwind untuk thumbnail kartu. */
  swatch: string;
}

/**
 * Booster fotografi otomotif yang ditambahkan di belakang deskripsi scene.
 * SD 1.5 memakai CLIP (batas ~77 token), jadi scene diletakkan di depan dan
 * booster dibuat ringkas.
 */
export const AUTOMOTIVE_BOOSTER =
  "realistic environment reflections on glossy car paint, soft contact shadows under tires, 35mm lens, photorealistic, professional automotive photography, sharp focus, high detail";

export const DEFAULT_NEGATIVE_PROMPT =
  "cartoon, illustration, painting, drawing, anime, cgi, 3d render, deformed, distorted, extra wheels, duplicate car, second car, floating car, blurry, low quality, lowres, jpeg artifacts, watermark, text, logo, signature, people, oversaturated";

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: "jakarta-golden-hour",
    name: "Modern Urban Jakarta (Golden Hour)",
    description: "Jalan aspal modern, gedung kaca, matahari terbenam.",
    scene:
      "a car parked on a clean modern asphalt street in downtown Jakarta at golden hour, glass skyscrapers in the background, warm low sunlight, long soft shadows",
    swatch: "from-amber-400 via-orange-500 to-rose-700",
  },
  {
    id: "highland-mountain-road",
    name: "Scenic Highland Mountain Road",
    description: "Jalan pegunungan berkabut, alam hijau pagi hari.",
    scene:
      "a car on a winding mountain road in misty highlands at early morning, lush green hills and pine trees, soft fog, gentle diffused sunlight",
    swatch: "from-emerald-300 via-teal-600 to-slate-800",
  },
  {
    id: "luxury-showroom",
    name: "Luxury Minimalist Showroom",
    description: "Lantai beton/marmer, pencahayaan studio arsitektural.",
    scene:
      "a car inside a luxury minimalist showroom, polished concrete and marble floor, architectural studio lighting, soft overhead light panels, clean grey walls",
    swatch: "from-zinc-200 via-zinc-400 to-zinc-700",
  },
  {
    id: "coastal-sunset-highway",
    name: "Coastal Sunset Highway",
    description: "Jalan pesisir pantai, langit senja dramatis.",
    scene:
      "a car on a coastal highway by the ocean at sunset, dramatic orange and purple sky, calm sea horizon, warm rim light",
    swatch: "from-fuchsia-500 via-orange-400 to-sky-700",
  },
  {
    id: "night-city-street",
    name: "Night City Street",
    description: "Kota malam, aspal basah, pantulan lampu kota.",
    scene:
      "a car on a city street at night, slightly wet asphalt reflecting neon signs and street lights, bokeh city lights, cinematic moody lighting",
    swatch: "from-indigo-500 via-violet-700 to-slate-950",
  },
];

export const CUSTOM_PRESET_ID = "custom";

export function buildPrompt(scene: string, useBooster: boolean): string {
  const s = scene.trim().replace(/[\s,]+$/, "");
  if (!useBooster) return s;
  if (!s) return AUTOMOTIVE_BOOSTER;
  return `${s}, ${AUTOMOTIVE_BOOSTER}`;
}
