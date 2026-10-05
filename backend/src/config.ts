import path from "node:path";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${name}: "${raw}" (expected a positive integer)`);
  }
  return parsed;
}

const dataDir = process.env.DATA_DIR ?? "/data";

export const config = {
  port: intFromEnv("PORT", 3000),
  dataDir,
  dbPath: path.join(dataDir, "how-high.db"),
  demDir: path.join(dataDir, "dem"),
  uploadsDir: path.join(dataDir, "uploads"),
  maxUploadBytes: intFromEnv("MAX_UPLOAD_MB", 20) * 1024 * 1024,
  // Routes from Google Maps links are only offered when a key is set.
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null,
};
