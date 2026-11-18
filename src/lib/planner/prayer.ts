// Prayer times from standard solar formulas (NOAA approximations), so a prayer break lands when
// the prayer actually is. No network calls. Asr uses the Hanafi shadow factor (2), common in Pakistan.

export interface PrayerPlace {
  name: string;
  lat: number;
  lon: number;
  /** offset from UTC in hours */
  tz: number;
}

export const DEFAULT_PLACE: PrayerPlace = { name: "Islamabad", lat: 33.6844, lon: 73.0479, tz: 5 };

export function placeFromEnv(): PrayerPlace {
  const lat = Number(process.env.MTM_LAT);
  const lon = Number(process.env.MTM_LON);
  const tz = Number(process.env.MTM_TZ);
  return {
    name: process.env.MTM_CITY ?? (process.env.MTM_LAT ? "configured location" : DEFAULT_PLACE.name),
    lat: Number.isFinite(lat) && process.env.MTM_LAT ? lat : DEFAULT_PLACE.lat,
    lon: Number.isFinite(lon) && process.env.MTM_LON ? lon : DEFAULT_PLACE.lon,
    tz: Number.isFinite(tz) && process.env.MTM_TZ ? tz : DEFAULT_PLACE.tz,
  };
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Minutes after local midnight when Zuhr (Dhuhr) and Asr begin on the given date. */
export function prayerTimes(date: Date, place: PrayerPlace = DEFAULT_PLACE): { dhuhr: number; asr: number } {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000) + 1;
  const g = ((2 * Math.PI) / 365) * (doy - 1);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const noon = 720 - 4 * place.lon - eqTime + place.tz * 60;
  const lat = rad(place.lat);
  const shadow = 2; // Hanafi
  const alt = Math.atan(1 / (shadow + Math.tan(Math.abs(lat - decl))));
  const ha = deg(Math.acos((Math.sin(alt) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl))));
  return { dhuhr: Math.round(noon + 2), asr: Math.round(noon + ha * 4) };
}

/** Which prayer a break label refers to (null = not a prayer break). */
export function prayerKind(label: string | undefined): "dhuhr" | "asr" | "any" | null {
  const l = (label ?? "").toLowerCase();
  if (!/(prayer|namaz|namaaz|salah|salat|zuhr|zohr|dhuhr|asr|jum)/.test(l)) return null;
  if (/asr/.test(l)) return "asr";
  if (/(zuhr|zohr|dhuhr|jum)/.test(l)) return "dhuhr";
  return "any";
}
