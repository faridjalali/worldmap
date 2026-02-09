export const SOURCES = {
  topo: [
    "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
    "https://unpkg.com/world-atlas@2/countries-110m.json",
  ],
  countries: [
    "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json",
    "https://unpkg.com/world-countries@5.1.0/countries.json",
  ],
  cities: ["./cities.json"],
};

export const CONTINENTS: Record<string, { label: string; color: string }> = {
  "north-america": { label: "North America", color: "#e6c288" },
  "south-america": { label: "South America", color: "#a8c686" },
  europe: { label: "Europe", color: "#d8a499" },
  africa: { label: "Africa", color: "#e8d8a5" },
  asia: { label: "Asia", color: "#c4a484" },
  oceania: { label: "Oceania", color: "#99badd" },
};

export const GLOBE_COLORS = {
  ocean: "#004866",
  stroke: "#000000",
  default: "#d0d0d0",
  continents: Object.fromEntries(
    Object.entries(CONTINENTS).map(([k, v]) => [k, v.color]),
  ) as Record<string, string>,
};

export function pad3(n: string | number): string {
  const s = String(n);
  return s.length >= 3 ? s : s.padStart(3, "0");
}

export async function fetchFirstOk<T>(urls: string[], label: string): Promise<T> {
  let lastErr: any = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error(`${label} fetch failed (${res.status})`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `${label} failed on all sources. ${lastErr ? lastErr.message : ""}`,
  );
}

export interface CountryMeta {
  region: string;
  subregion: string;
  name?: { common: string };
  ccn3?: string;
}

export function resolveContinent(meta: CountryMeta): string | null {
  const region = (meta.region || "").toLowerCase();
  const subregion = (meta.subregion || "").toLowerCase();

  if (region === "americas") {
    if (subregion.includes("south")) return "south-america";
    return "north-america";
  }
  if (region === "europe") return "europe";
  if (region === "africa") return "africa";
  if (region === "asia") return "asia";
  if (region === "oceania") return "oceania";
  return null;
}

export function clamp(min: number, max: number, v: number): number {
  return Math.max(min, Math.min(max, v));
}

export function formatContinentName(slug: string): string {
  if (!slug) return "";
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
