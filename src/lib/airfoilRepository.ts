import { supabase } from "../utils/supabase.ts";
import { BZ } from "./lbm/bezierShape.js";
import { parseDatText } from "./airfoilParser.js";
import {
  sanitizeCalibration,
  type AeroCalibration,
  type AxisDir,
  type BoundingBoxDims,
  type ModelClass,
} from "./calibration.ts";

export interface UserProfileDoc {
  uid: string;
  displayName: string;
  photoURL: string;
  totalUploads: number;
  totalRuns: number;
  bestLd: number;
  bestAirfoil: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export const AIRFOILS_BUCKET = "airfoils";
export const AVATARS_BUCKET = "avatars";
export const RESULTS_BUCKET = "results";
export const MODELS_BUCKET = "models";

export interface PilotDetails {
  displayName: string;
  bio: string;
  role: string;
  organization: string;
  location: string;
  photoURL: string;
  bannerURL: string;
  storageWarning?: string;
}

export interface SharedAirfoilDoc {
  id: string;
  name: string;
  filename: string;
  coordsText: string;
  pointCount: number;
  camberPct: number;
  thicknessPct: number;
  uploaderName: string;
  uploaderUid: string;
  isNeutralRef: boolean;
  visibility: "public";
  createdAtMs: number;
  storagePath: string;
  storageUrl: string;
  storageWarning?: string;
}

export interface BenchmarkRunDoc {
  id: string;
  airfoilName: string;
  airfoilId: string;
  kind: "best_run" | "neutral_ref";
  alpha: number;
  reynolds: number;
  cl: number;
  cd: number;
  ld: number;
  separationPct: number;
  sourceLabel: string;
  recorderUid: string;
  visibility: "public";
  createdAtMs: number;
  storagePath: string;
  storageUrl: string;
  storageWarning?: string;
}

export interface SharedGlbModelDoc {
  id: string;
  name: string;
  filename: string;
  fileSizeBytes: number;
  modelClass: ModelClass;
  noseAxis: AxisDir;
  upAxis: AxisDir;
  calibration: AeroCalibration;
  bounds: BoundingBoxDims;
  uploaderName: string;
  uploaderUid: string;
  visibility: "public";
  createdAtMs: number;
  storagePath: string;
  storageUrl: string;
  storageWarning?: string;
}

export interface NeutralReferenceData {
  label: string;
  sourceType: "builtin" | "file" | "airfoil";
  airfoilName: string;
  rows: Array<{
    alpha: number;
    cl: number;
    cd: number;
    ld: number;
    separationPct?: number;
  }>;
}

export const SUPABASE_SYNC_EVENT = "aerolab:supabase-sync";

function getBucketPublicUrl(bucket: string, objectPath: string): string {
  if (!supabase || !objectPath) return "";
  const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
  return data?.publicUrl || "";
}

async function uploadBlobToBucket(
  bucket: string,
  objectPath: string,
  blob: Blob,
  contentType: string
): Promise<{ ok: true; publicUrl: string } | { ok: false; error: string }> {
  const client = requireSupabase();
  try {
    const { error } = await client.storage.from(bucket).upload(objectPath, blob, {
      upsert: true,
      contentType,
    });
    if (error) {
      return { ok: false, error: error.message || `Bucket "${bucket}" upload failed.` };
    }
    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
    return { ok: true, publicUrl: data?.publicUrl || "" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "File upload failed.",
    };
  }
}

async function removeObjectsFromBucket(bucket: string, objectPaths: string[]): Promise<void> {
  if (!supabase || !objectPaths.length) return;
  try {
    await supabase.storage.from(bucket).remove(objectPaths);
  } catch {
    // ignore storage cleanup errors
  }
}

function requireSupabase() {
  if (!supabase) {
    throw new Error("Cloud sync is not available right now.");
  }
  return supabase;
}

export type SyncScope = "profiles" | "airfoils" | "benchmarks" | "glb_models";
const SYNC_CHANNEL_NAME = "aerolab:realtime-sync";

export function emitSync(scope: SyncScope) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SUPABASE_SYNC_EVENT, { detail: { scope } }));
    if (typeof BroadcastChannel !== "undefined") {
      try {
        const bc = new BroadcastChannel(SYNC_CHANNEL_NAME);
        bc.postMessage({ scope });
        bc.close();
      } catch {
        // ignore BroadcastChannel failures
      }
    }
  }
}

function formatSupabaseError(error: { code?: string; message?: string } | null | undefined, fallback: string): Error {
  if (!error) return new Error(fallback);
  if (error.code === "PGRST205" || error.message?.includes("schema cache")) {
    return new Error("Cloud sync is not ready yet.");
  }
  return new Error(error.message || fallback);
}

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

function makeValidDocId(prefix: string, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  const rand = Math.random().toString(36).slice(2, 8);
  const raw = `${prefix}_${slug || "item"}_${Date.now()}_${rand}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function toMillis(ts: unknown): number {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function resampleCoords(coords: number[][], maxPts = 200): number[][] {
  if (coords.length <= maxPts) return coords;
  const out: number[][] = [];
  const last = coords.length - 1;
  for (let i = 0; i < maxPts; i++) {
    const idx = Math.round((i / (maxPts - 1)) * last);
    out.push(coords[idx]);
  }
  return out;
}

export function formatSeligDat(name: string, coords: number[][]): { coordsText: string; pointCount: number } {
  const safeName = (name || "airfoil").replace(/[\r\n]+/g, " ").trim().slice(0, 72) || "airfoil";
  const sampled = resampleCoords(coords, 240);
  const lines = sampled.map(
    ([x, y]) => `${Number(x).toFixed(6).padStart(10)} ${Number(y).toFixed(6).padStart(10)}`
  );
  let coordsText = `${safeName}\n${lines.join("\n")}\n`;
  if (coordsText.length > 39500) {
    const smaller = resampleCoords(coords, 120);
    coordsText =
      `${safeName}\n` +
      smaller.map(([x, y]) => `${Number(x).toFixed(5).padStart(9)} ${Number(y).toFixed(5).padStart(9)}`).join("\n") +
      "\n";
    return { coordsText, pointCount: smaller.length };
  }
  return { coordsText, pointCount: sampled.length };
}

export function computeAirfoilGeometryStats(coords: number[][]): { camberPct: number; thicknessPct: number } {
  try {
    const { shape } = BZ.fit(coords);
    const stats = BZ.stats(shape);
    return {
      camberPct: Number(clamp(stats.camber * 100, -30, 30).toFixed(2)),
      thicknessPct: Number(clamp(stats.thick * 100, 0.5, 60).toFixed(2)),
    };
  } catch {
    const ys = coords.map((p) => p[1]);
    const thick = ys.length ? (Math.max(...ys) - Math.min(...ys)) * 100 : 12;
    return {
      camberPct: 0,
      thicknessPct: Number(clamp(thick, 0.5, 60).toFixed(2)),
    };
  }
}

function mapUserProfile(row: Record<string, unknown>, fallbackUid: string): UserProfileDoc {
  return {
    uid: String(row.uid || fallbackUid),
    displayName: String(row.display_name || "AeroLab Pilot"),
    photoURL: String(row.photo_url || ""),
    totalUploads: Number(row.total_uploads || 0),
    totalRuns: Number(row.total_runs || 0),
    bestLd: Number(row.best_ld || 0),
    bestAirfoil: String(row.best_airfoil || ""),
    createdAtMs: toMillis(row.created_at),
    updatedAtMs: toMillis(row.updated_at),
  };
}

function mapAirfoilRow(row: Record<string, unknown>): SharedAirfoilDoc {
  const id = String(row.id || "");
  const uploaderUid = String(row.uploader_uid || "");
  const storagePath = id ? `${uploaderUid || "community"}/${id}.dat` : "";
  return {
    id,
    name: String(row.name || "Untitled"),
    filename: String(row.filename || "airfoil.dat"),
    coordsText: String(row.coords_text || ""),
    pointCount: Number(row.point_count || 0),
    camberPct: Number(row.camber_pct || 0),
    thicknessPct: Number(row.thickness_pct || 12),
    uploaderName: String(row.uploader_name || "Community"),
    uploaderUid,
    isNeutralRef: Boolean(row.is_neutral_ref),
    visibility: "public" as const,
    createdAtMs: toMillis(row.created_at),
    storagePath,
    storageUrl: getBucketPublicUrl(AIRFOILS_BUCKET, storagePath),
  };
}

function mapBenchmarkRow(row: Record<string, unknown>): BenchmarkRunDoc {
  const id = String(row.id || "");
  const recorderUid = String(row.recorder_uid || "");
  const storagePath = id ? `${recorderUid || "community"}/${id}.json` : "";
  return {
    id,
    airfoilName: String(row.airfoil_name || "Unknown"),
    airfoilId: String(row.airfoil_id || ""),
    kind: (row.kind === "neutral_ref" ? "neutral_ref" : "best_run") as "best_run" | "neutral_ref",
    alpha: Number(row.alpha || 0),
    reynolds: Number(row.reynolds || 2560),
    cl: Number(row.cl || 0),
    cd: Number(row.cd || 0),
    ld: Number(row.ld || 0),
    separationPct: Number(row.separation_pct || 0),
    sourceLabel: String(row.source_label || "2D LBM Solver"),
    recorderUid,
    visibility: "public" as const,
    createdAtMs: toMillis(row.created_at),
    storagePath,
    storageUrl: getBucketPublicUrl(RESULTS_BUCKET, storagePath),
  };
}

function mapGlbModelRow(row: Record<string, unknown>): SharedGlbModelDoc {
  const id = String(row.id || "");
  const uploaderUid = String(row.uploader_uid || "");
  const storagePath = String(row.storage_path || (id ? `${uploaderUid || "community"}/${id}.glb` : ""));
  const calibration = sanitizeCalibration(row.calibration);
  const rawBounds =
    row.bounds && typeof row.bounds === "object"
      ? (row.bounds as Record<string, unknown>)
      : {};
  const bounds: BoundingBoxDims = {
    x: Number(rawBounds.x) > 0 ? Number(rawBounds.x) : 1,
    y: Number(rawBounds.y) > 0 ? Number(rawBounds.y) : 0.3,
    z: Number(rawBounds.z) > 0 ? Number(rawBounds.z) : 0.6,
  };
  const rawUrl = typeof row.storage_url === "string" ? row.storage_url.trim() : "";

  return {
    id,
    name: String(row.name || "Custom 3D Model"),
    filename: String(row.filename || "model.glb"),
    fileSizeBytes: Math.max(0, Number(row.file_size_bytes || 0)),
    modelClass: calibration.modelClass,
    noseAxis: calibration.noseAxis,
    upAxis: calibration.upAxis,
    calibration,
    bounds,
    uploaderName: String(row.uploader_name || "Community"),
    uploaderUid,
    visibility: "public" as const,
    createdAtMs: toMillis(row.created_at),
    storagePath,
    storageUrl: rawUrl || getBucketPublicUrl(MODELS_BUCKET, storagePath),
  };
}

export function subscribeUserProfile(
  uid: string,
  onData: (profile: UserProfileDoc | null) => void,
  onError?: (err: Error) => void
): () => void {
  if (!supabase) {
    onData(null);
    return () => {};
  }
  const client = supabase;
  let active = true;

  const fetchProfile = async () => {
    const { data, error } = await client
      .from("user_profiles")
      .select("*")
      .eq("uid", uid)
      .maybeSingle();

    if (!active) return;
    if (error) {
      onError?.(formatSupabaseError(error, "Could not load pilot profile."));
      return;
    }
    onData(data ? mapUserProfile(data as Record<string, unknown>, uid) : null);
  };

  void fetchProfile();

  const onLocalSync = (evt: Event) => {
    const detail = (evt as CustomEvent<{ scope?: string }>).detail;
    if (detail?.scope === "profiles") {
      void fetchProfile();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener(SUPABASE_SYNC_EVENT, onLocalSync);
  }

  const channel = client
    .channel(`user_profile_${uid}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "user_profiles", filter: `uid=eq.${uid}` },
      () => {
        void fetchProfile();
      }
    )
    .subscribe();

  return () => {
    active = false;
    if (typeof window !== "undefined") {
      window.removeEventListener(SUPABASE_SYNC_EVENT, onLocalSync);
    }
    void client.removeChannel(channel);
  };
}

export async function ensureUserProfile(statsHint?: {
  totalUploads?: number;
  totalRuns?: number;
  bestLd?: number;
  bestAirfoil?: string;
  displayName?: string;
}): Promise<void> {
  if (!supabase) return;
  const client = supabase;
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return;

  const metaName =
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    user.email?.split("@")[0] ||
    "AeroLab Pilot";
  const fallbackName = metaName.slice(0, 80);
  const photoURL = String(user.user_metadata?.avatar_url || user.user_metadata?.picture || "").slice(0, 512);

  const { data: existing, error: fetchError } = await client
    .from("user_profiles")
    .select("*")
    .eq("uid", user.id)
    .maybeSingle();

  if (fetchError) {
    throw formatSupabaseError(fetchError, "Could not verify pilot profile.");
  }

  if (!existing) {
    const displayName = (statsHint?.displayName?.trim() || fallbackName).slice(0, 80);
    const { error: insertError } = await client.from("user_profiles").insert({
      uid: user.id,
      display_name: displayName,
      photo_url: photoURL,
      total_uploads: Math.trunc(clamp(statsHint?.totalUploads ?? 0, 0, 100000)),
      total_runs: Math.trunc(clamp(statsHint?.totalRuns ?? 0, 0, 100000)),
      best_ld: Number(clamp(statsHint?.bestLd ?? 0, -100, 300).toFixed(3)),
      best_airfoil: (statsHint?.bestAirfoil || "").slice(0, 80),
    });
    if (insertError) {
      throw formatSupabaseError(insertError, "Could not create pilot profile.");
    }
  } else {
    const existingName = String(existing.display_name || "").trim();
    const displayName = (statsHint?.displayName?.trim() || existingName || fallbackName).slice(0, 80);
    const nextUploads = Math.max(Number(existing.total_uploads || 0), statsHint?.totalUploads ?? 0);
    const nextRuns = Math.max(Number(existing.total_runs || 0), statsHint?.totalRuns ?? 0);
    const candidateLd = statsHint?.bestLd ?? -100;
    const existingLd = Number(existing.best_ld || 0);
    const bestLd = candidateLd > existingLd ? candidateLd : existingLd;
    const bestAirfoil =
      candidateLd > existingLd && statsHint?.bestAirfoil
        ? statsHint.bestAirfoil.slice(0, 80)
        : String(existing.best_airfoil || "").slice(0, 80);

    const { error: updateError } = await client
      .from("user_profiles")
      .update({
        display_name: displayName,
        photo_url: photoURL || String(existing.photo_url || "").slice(0, 512),
        total_uploads: Math.trunc(clamp(nextUploads, 0, 100000)),
        total_runs: Math.trunc(clamp(nextRuns, 0, 100000)),
        best_ld: Number(clamp(bestLd, -100, 300).toFixed(3)),
        best_airfoil: bestAirfoil,
        updated_at: new Date().toISOString(),
      })
      .eq("uid", user.id);

    if (updateError) {
      throw formatSupabaseError(updateError, "Could not update pilot profile.");
    }
  }

  emitSync("profiles");
}

const LOCAL_AVATAR_KEY_PREFIX = "aerolab:avatar:";
const LOCAL_BANNER_KEY_PREFIX = "aerolab:banner:";
const LOCAL_DETAILS_KEY_PREFIX = "aerolab:pilot-details:";

export function getLocalAvatar(uid: string): string {
  if (typeof window === "undefined" || !uid) return "";
  try {
    return window.localStorage.getItem(`${LOCAL_AVATAR_KEY_PREFIX}${uid}`) || "";
  } catch {
    return "";
  }
}

export function saveLocalAvatar(uid: string, dataUrl: string | null): boolean {
  if (typeof window === "undefined" || !uid) return false;
  try {
    const key = `${LOCAL_AVATAR_KEY_PREFIX}${uid}`;
    if (dataUrl) {
      window.localStorage.setItem(key, dataUrl);
    } else {
      window.localStorage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}

export function getLocalBanner(uid: string): string {
  if (typeof window === "undefined" || !uid) return "";
  try {
    return window.localStorage.getItem(`${LOCAL_BANNER_KEY_PREFIX}${uid}`) || "";
  } catch {
    return "";
  }
}

export function saveLocalBanner(uid: string, dataUrl: string | null): boolean {
  if (typeof window === "undefined" || !uid) return false;
  try {
    const key = `${LOCAL_BANNER_KEY_PREFIX}${uid}`;
    if (dataUrl) {
      window.localStorage.setItem(key, dataUrl);
    } else {
      window.localStorage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}

export function getLocalPilotDetails(uid: string): Partial<PilotDetails> {
  if (typeof window === "undefined" || !uid) return {};
  try {
    const raw = window.localStorage.getItem(`${LOCAL_DETAILS_KEY_PREFIX}${uid}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PilotDetails>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveLocalPilotDetails(uid: string, details: Partial<PilotDetails>): void {
  if (typeof window === "undefined" || !uid) return;
  try {
    window.localStorage.setItem(`${LOCAL_DETAILS_KEY_PREFIX}${uid}`, JSON.stringify(details));
  } catch {
    // ignore storage failures
  }
}

const SUPPORTED_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i;
const UNSUPPORTED_RAW_EXT_RE = /\.(heic|heif|dng|cr2|nef|arw|rw2|orf)$/i;

function assertSupportedImageFile(file: File): void {
  const mime = (file.type || "").toLowerCase();
  const name = file.name || "";

  if (
    mime === "image/heic" ||
    mime === "image/heif" ||
    UNSUPPORTED_RAW_EXT_RE.test(name)
  ) {
    throw new Error(
      "HEIC/HEIF and camera RAW images cannot be decoded directly by this browser. Convert or export the photo as JPG, PNG, or WebP and try again."
    );
  }

  const hasImageMime = mime.startsWith("image/");
  const hasSupportedExt = SUPPORTED_IMAGE_EXT_RE.test(name);
  if (!hasImageMime && !hasSupportedExt) {
    throw new Error("Please select an image file (PNG, JPG, WebP, GIF, BMP, or AVIF).");
  }

  if (file.size === 0) {
    throw new Error("The selected image file is empty (0 bytes).");
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Profile image must be 10 MB or smaller.");
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:")) {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read file bytes."));
      }
    };
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Image decode failed."));
    el.src = src;
  });
}

function dataUrlToBlob(dataUrl: string, fallbackMime = "image/jpeg"): Blob {
  const parts = dataUrl.split(",");
  const header = parts[0] || "";
  const base64 = parts[1] || "";
  const mimeMatch = header.match(/data:([^;]+);/);
  const mime = mimeMatch?.[1] || fallbackMime;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function decodeImageSource(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}> {
  // 1. Prefer createImageBitmap (decodes directly from Blob without blob: URL CSP issues)
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => bitmap.close(),
        };
      }
      bitmap.close();
    } catch {
      // Fall through to FileReader Data URL
    }
  }

  // 2. Fallback to FileReader Data URL + <img> (works in sandboxed iframes that restrict blob: URLs)
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const img = await loadImageElement(dataUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w > 0 && h > 0) {
      return { source: img, width: w, height: h, cleanup: () => {} };
    }
  } catch {
    // Fall through to object URL
  }

  // 3. Final fallback to object URL
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(objectUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w > 0 && h > 0) {
      return {
        source: img,
        width: w,
        height: h,
        cleanup: () => URL.revokeObjectURL(objectUrl),
      };
    }
    URL.revokeObjectURL(objectUrl);
  } catch {
    URL.revokeObjectURL(objectUrl);
  }

  throw new Error(
    "Could not decode this image file. It may be corrupted or use an unsupported codec (such as HEIC on Apple devices)—try saving as JPG or PNG."
  );
}

async function processCroppedImage(
  file: File,
  targetWidth: number,
  targetHeight: number,
  quality = 0.86
): Promise<{ dataUrl: string; blob: Blob }> {
  assertSupportedImageFile(file);

  const decoded = await decodeImageSource(file);
  try {
    const natW = decoded.width;
    const natH = decoded.height;
    const targetAspect = targetWidth / targetHeight;
    const srcAspect = natW / natH;

    let sx = 0;
    let sy = 0;
    let sw = natW;
    let sh = natH;
    if (srcAspect > targetAspect) {
      sw = natH * targetAspect;
      sx = (natW - sw) / 2;
    } else {
      sh = natW / targetAspect;
      sy = (natH - sh) / 2;
    }

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas image processing is unavailable in this browser.");
    }

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(decoded.source, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

    const mime = "image/jpeg";
    const dataUrl = canvas.toDataURL(mime, quality);
    const blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob(
        (b) => resolve(b || dataUrlToBlob(dataUrl, mime)),
        mime,
        quality
      );
    });

    return { dataUrl, blob };
  } finally {
    decoded.cleanup();
  }
}

export async function processAvatarImage(file: File): Promise<{ dataUrl: string; blob: Blob }> {
  return processCroppedImage(file, 256, 256, 0.86);
}

export async function processBannerImage(file: File): Promise<{ dataUrl: string; blob: Blob }> {
  return processCroppedImage(file, 1200, 320, 0.85);
}

export async function updatePilotProfile(input: {
  displayName: string;
  bio: string;
  role: string;
  organization: string;
  location: string;
  avatarFile?: File | null;
  avatarDataUrl?: string | null;
  removeAvatar?: boolean;
  bannerFile?: File | null;
  bannerDataUrl?: string | null;
  removeBanner?: boolean;
  localUid?: string;
}): Promise<PilotDetails> {
  const cleanName = input.displayName.trim().slice(0, 80);
  if (!cleanName) {
    throw new Error("Display name cannot be empty.");
  }
  const cleanBio = input.bio.trim().slice(0, 280);
  const cleanRole = input.role.trim().slice(0, 60);
  const cleanOrganization = input.organization.trim().slice(0, 60);
  const cleanLocation = input.location.trim().slice(0, 60);

  // Local-only mode when Supabase is not configured or local pilot session is active
  if (!supabase || input.localUid?.startsWith("local:")) {
    const uid = input.localUid || "local:pilot";
    let photoURL = getLocalAvatar(uid);
    let bannerURL = getLocalBanner(uid);
    const warnings: string[] = [];

    if (input.removeAvatar) {
      saveLocalAvatar(uid, null);
      photoURL = "";
    } else if (input.avatarDataUrl || input.avatarFile) {
      const dataUrl = input.avatarDataUrl || (await processAvatarImage(input.avatarFile!)).dataUrl;
      const saved = saveLocalAvatar(uid, dataUrl);
      photoURL = dataUrl;
      if (!saved) warnings.push("Browser storage is full; avatar will persist for this session only.");
    }

    if (input.removeBanner) {
      saveLocalBanner(uid, null);
      bannerURL = "";
    } else if (input.bannerDataUrl || input.bannerFile) {
      const dataUrl = input.bannerDataUrl || (await processBannerImage(input.bannerFile!)).dataUrl;
      const saved = saveLocalBanner(uid, dataUrl);
      bannerURL = dataUrl;
      if (!saved) warnings.push("Browser storage is full; cover image will persist for this session only.");
    }

    saveLocalPilotDetails(uid, {
      displayName: cleanName,
      bio: cleanBio,
      role: cleanRole,
      organization: cleanOrganization,
      location: cleanLocation,
    });

    emitSync("profiles");

    return {
      displayName: cleanName,
      bio: cleanBio,
      role: cleanRole,
      organization: cleanOrganization,
      location: cleanLocation,
      photoURL,
      bannerURL,
      storageWarning: warnings.length ? warnings.join("; ") : undefined,
    };
  }

  const client = supabase;
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) {
    throw new Error("Sign in to update your pilot profile.");
  }

  let nextPhotoUrl: string | undefined;
  let nextLocalPhoto: string | undefined;
  let nextBannerUrl: string | undefined;
  let nextLocalBanner: string | undefined;
  const warnings: string[] = [];

  if (input.removeAvatar) {
    saveLocalAvatar(user.id, null);
    nextPhotoUrl = "";
    nextLocalPhoto = "";
  } else if (input.avatarDataUrl || input.avatarFile) {
    const processed = input.avatarDataUrl
      ? { dataUrl: input.avatarDataUrl, blob: dataUrlToBlob(input.avatarDataUrl, "image/jpeg") }
      : await processAvatarImage(input.avatarFile!);
    const objectPath = `${user.id}/avatar-${Date.now()}.jpg`;
    const uploaded = await uploadBlobToBucket(AVATARS_BUCKET, objectPath, processed.blob, "image/jpeg");
    if (uploaded.ok && uploaded.publicUrl) {
      nextPhotoUrl = uploaded.publicUrl;
      saveLocalAvatar(user.id, null);
    } else {
      nextLocalPhoto = processed.dataUrl;
      saveLocalAvatar(user.id, processed.dataUrl);
      if (!uploaded.ok) warnings.push(`Avatar stored locally (${uploaded.error})`);
    }
  }

  if (input.removeBanner) {
    saveLocalBanner(user.id, null);
    nextBannerUrl = "";
    nextLocalBanner = "";
  } else if (input.bannerDataUrl || input.bannerFile) {
    const processed = input.bannerDataUrl
      ? { dataUrl: input.bannerDataUrl, blob: dataUrlToBlob(input.bannerDataUrl, "image/jpeg") }
      : await processBannerImage(input.bannerFile!);
    const objectPath = `${user.id}/profile-cover-${Date.now()}.jpg`;
    const uploaded = await uploadBlobToBucket(AVATARS_BUCKET, objectPath, processed.blob, "image/jpeg");
    if (uploaded.ok && uploaded.publicUrl) {
      nextBannerUrl = uploaded.publicUrl;
      saveLocalBanner(user.id, null);
    } else {
      nextLocalBanner = processed.dataUrl;
      saveLocalBanner(user.id, processed.dataUrl);
      if (!uploaded.ok) warnings.push(`Profile cover stored locally (${uploaded.error})`);
    }
  }

  await ensureUserProfile({ displayName: cleanName });

  const profilePatch: Record<string, unknown> = {
    display_name: cleanName,
    updated_at: new Date().toISOString(),
  };
  if (nextPhotoUrl !== undefined) {
    profilePatch.photo_url = nextPhotoUrl.slice(0, 512);
  }

  const { error } = await client
    .from("user_profiles")
    .update(profilePatch)
    .eq("uid", user.id);

  if (error) {
    throw formatSupabaseError(error, "Could not update pilot profile.");
  }

  const metadataPatch: Record<string, unknown> = {
    full_name: cleanName,
    bio: cleanBio,
    role: cleanRole,
    organization: cleanOrganization,
    location: cleanLocation,
  };
  if (input.removeAvatar) {
    metadataPatch.avatar_url = "";
    metadataPatch.avatar_removed = true;
  } else if (input.avatarFile || input.avatarDataUrl) {
    metadataPatch.avatar_removed = false;
    if (nextPhotoUrl !== undefined) {
      metadataPatch.avatar_url = nextPhotoUrl;
    }
  }
  if (input.removeBanner) {
    metadataPatch.banner_url = "";
  } else if (nextBannerUrl !== undefined) {
    metadataPatch.banner_url = nextBannerUrl;
  }

  const { error: authErr } = await client.auth.updateUser({ data: metadataPatch });
  if (authErr) {
    throw new Error(authErr.message || "Could not save profile metadata.");
  }

  const existingLocalAvatar = getLocalAvatar(user.id);
  const resolvedPhotoURL =
    nextPhotoUrl !== undefined
      ? nextPhotoUrl || nextLocalPhoto || ""
      : existingLocalAvatar ||
        (user.user_metadata?.avatar_removed === true
          ? ""
          : String(user.user_metadata?.avatar_url || user.user_metadata?.picture || ""));

  const existingLocalBanner = getLocalBanner(user.id);
  const resolvedBannerURL =
    nextBannerUrl !== undefined
      ? nextBannerUrl || nextLocalBanner || ""
      : existingLocalBanner || String(user.user_metadata?.banner_url || "");

  saveLocalPilotDetails(user.id, {
    displayName: cleanName,
    bio: cleanBio,
    role: cleanRole,
    organization: cleanOrganization,
    location: cleanLocation,
  });

  emitSync("profiles");

  return {
    displayName: cleanName,
    bio: cleanBio,
    role: cleanRole,
    organization: cleanOrganization,
    location: cleanLocation,
    photoURL: resolvedPhotoURL,
    bannerURL: resolvedBannerURL,
    storageWarning: warnings.length ? warnings.join("; ") : undefined,
  };
}

export async function updateUserDisplayName(nextName: string): Promise<string> {
  const client = requireSupabase();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) {
    throw new Error("Sign in to update your pilot profile.");
  }
  const cleanName = nextName.trim().slice(0, 80);
  if (!cleanName) {
    throw new Error("Display name cannot be empty.");
  }

  await ensureUserProfile({ displayName: cleanName });

  const { error } = await client
    .from("user_profiles")
    .update({
      display_name: cleanName,
      updated_at: new Date().toISOString(),
    })
    .eq("uid", user.id);

  if (error) {
    throw formatSupabaseError(error, "Could not update display name.");
  }

  void client.auth.updateUser({ data: { full_name: cleanName } }).catch(() => {});
  emitSync("profiles");
  return cleanName;
}

export function subscribePublicAirfoils(
  onData: (items: SharedAirfoilDoc[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!supabase) {
    onData([]);
    return () => {};
  }
  const client = supabase;
  let active = true;

  const fetchAirfoils = async () => {
    const { data, error } = await client
      .from("airfoils")
      .select("*")
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .limit(80);

    if (!active) return;
    if (error) {
      onError?.(formatSupabaseError(error, "Could not load community airfoils."));
      return;
    }
    const items = (data || [])
      .map((row) => mapAirfoilRow(row as Record<string, unknown>))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    onData(items);
  };

  void fetchAirfoils();

  const onLocalSync = (evt: Event) => {
    const detail = (evt as CustomEvent<{ scope?: string }>).detail;
    if (detail?.scope === "airfoils") {
      void fetchAirfoils();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener(SUPABASE_SYNC_EVENT, onLocalSync);
  }

  const channel = client
    .channel("public_airfoils")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "airfoils" },
      () => {
        void fetchAirfoils();
      }
    )
    .subscribe();

  return () => {
    active = false;
    if (typeof window !== "undefined") {
      window.removeEventListener(SUPABASE_SYNC_EVENT, onLocalSync);
    }
    void client.removeChannel(channel);
  };
}

export async function uploadSharedAirfoil(input: {
  name: string;
  filename: string;
  coords: number[][];
  rawDatText?: string;
  uploaderName?: string;
  isNeutralRef?: boolean;
}): Promise<SharedAirfoilDoc> {
  const cleanName = input.name.trim().slice(0, 80) || "Custom Airfoil";
  const cleanFile = input.filename.trim().slice(0, 100) || `${cleanName.replace(/\s+/g, "_")}.dat`;
  const { coordsText, pointCount } = formatSeligDat(cleanName, input.coords);
  const { camberPct, thicknessPct } = computeAirfoilGeometryStats(input.coords);

  const client = requireSupabase();
  const {
    data: { user },
  } = await client.auth.getUser();
  const verifiedUid = user?.id || "";
  const userFullName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined) ||
    "";
  const rawUploader = input.uploaderName?.trim() || userFullName || "Community";
  const uploaderName = rawUploader.slice(0, 60) || "Community";

  const id = makeValidDocId("foil", cleanName);
  const ownerFolder = verifiedUid || "community";
  const storagePath = `${ownerFolder}/${id}.dat`;
  const datFileBody = input.rawDatText?.trim() ? input.rawDatText : coordsText;
  const datBlob = new Blob([datFileBody], { type: "text/plain;charset=utf-8" });

  const storageRes = await uploadBlobToBucket(
    AIRFOILS_BUCKET,
    storagePath,
    datBlob,
    "text/plain;charset=utf-8"
  );

  const payload = {
    id,
    name: cleanName,
    filename: cleanFile,
    coords_text: coordsText,
    point_count: Math.trunc(clamp(pointCount, 10, 500)),
    camber_pct: camberPct,
    thickness_pct: thicknessPct,
    uploader_name: uploaderName,
    uploader_uid: verifiedUid,
    is_neutral_ref: Boolean(input.isNeutralRef),
    visibility: "public" as const,
  };

  const { data, error } = await client
    .from("airfoils")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw formatSupabaseError(error, "Could not publish airfoil.");
  }

  emitSync("airfoils");
  const mapped = data
    ? mapAirfoilRow(data as Record<string, unknown>)
    : {
        id,
        name: cleanName,
        filename: cleanFile,
        coordsText,
        pointCount: payload.point_count,
        camberPct,
        thicknessPct,
        uploaderName,
        uploaderUid: verifiedUid,
        isNeutralRef: payload.is_neutral_ref,
        visibility: "public" as const,
        createdAtMs: Date.now(),
        storagePath,
        storageUrl: storageRes.ok ? storageRes.publicUrl : getBucketPublicUrl(AIRFOILS_BUCKET, storagePath),
      };

  return {
    ...mapped,
    storageWarning: storageRes.ok ? undefined : storageRes.error,
  };
}

export async function deleteSharedAirfoil(id: string, uploaderUid?: string): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("airfoils").delete().eq("id", id);
  if (error) {
    throw formatSupabaseError(error, "Could not delete uploaded airfoil.");
  }
  const {
    data: { user },
  } = await client.auth.getUser();
  const ownerFolder = uploaderUid || user?.id || "community";
  await removeObjectsFromBucket(AIRFOILS_BUCKET, [`${ownerFolder}/${id}.dat`]);
  emitSync("airfoils");
}

export function subscribePublicBenchmarks(
  onData: (items: BenchmarkRunDoc[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!supabase) {
    onData([]);
    return () => {};
  }
  const client = supabase;
  let active = true;

  const fetchBenchmarks = async () => {
    const { data, error } = await client
      .from("benchmarks")
      .select("*")
      .eq("visibility", "public")
      .order("ld", { ascending: false })
      .limit(120);

    if (!active) return;
    if (error) {
      onError?.(formatSupabaseError(error, "Could not load benchmarks."));
      return;
    }
    const items = (data || [])
      .map((row) => mapBenchmarkRow(row as Record<string, unknown>))
      .sort((a, b) => b.ld - a.ld || b.createdAtMs - a.createdAtMs);
    onData(items);
  };

  void fetchBenchmarks();

  const onLocalSync = (evt: Event) => {
    const detail = (evt as CustomEvent<{ scope?: string }>).detail;
    if (detail?.scope === "benchmarks") {
      void fetchBenchmarks();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener(SUPABASE_SYNC_EVENT, onLocalSync);
  }

  const channel = client
    .channel("public_benchmarks")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "benchmarks" },
      () => {
        void fetchBenchmarks();
      }
    )
    .subscribe();

  return () => {
    active = false;
    if (typeof window !== "undefined") {
      window.removeEventListener(SUPABASE_SYNC_EVENT, onLocalSync);
    }
    void client.removeChannel(channel);
  };
}

export async function publishBenchmarkRun(input: {
  airfoilName: string;
  airfoilId?: string;
  kind?: "best_run" | "neutral_ref";
  alpha: number;
  reynolds: number;
  cl: number;
  cd: number;
  ld: number;
  separationPct: number;
  sourceLabel?: string;
  summaryExtra?: {
    regime?: string;
    optimalAlpha?: number;
    stallAlpha?: number;
    neurofoilPeakLd?: number;
    agreementPct?: number | null;
  };
}): Promise<BenchmarkRunDoc> {
  const client = requireSupabase();
  const id = makeValidDocId("run", input.airfoilName);
  const {
    data: { user },
  } = await client.auth.getUser();
  const recorderUid = user?.id || "";

  const payload = {
    id,
    airfoil_name: (input.airfoilName || "Airfoil").trim().slice(0, 80) || "Airfoil",
    airfoil_id: (input.airfoilId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128),
    kind: (input.kind === "neutral_ref" ? "neutral_ref" : "best_run") as "best_run" | "neutral_ref",
    alpha: Number(clamp(input.alpha, -30, 30).toFixed(2)),
    reynolds: Math.round(clamp(input.reynolds, 100, 1000000)),
    cl: Number(clamp(input.cl, -10, 10).toFixed(4)),
    cd: Number(clamp(input.cd, 0, 20).toFixed(4)),
    ld: Number(clamp(input.ld, -100, 300).toFixed(3)),
    separation_pct: Number(clamp(input.separationPct, 0, 100).toFixed(1)),
    source_label: (input.sourceLabel || "Live LBM Solver").trim().slice(0, 80),
    recorder_uid: recorderUid,
    visibility: "public" as const,
  };

  const { data, error } = await client
    .from("benchmarks")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw formatSupabaseError(error, "Could not publish benchmark.");
  }

  const ownerFolder = recorderUid || "community";
  const storagePath = `${ownerFolder}/${id}.json`;
  const summaryDocument = {
    id,
    airfoilName: payload.airfoil_name,
    airfoilId: payload.airfoil_id,
    kind: payload.kind,
    metrics: {
      alphaDeg: payload.alpha,
      reynolds: payload.reynolds,
      cl: payload.cl,
      cd: payload.cd,
      ldRatio: payload.ld,
      separationPct: payload.separation_pct,
    },
    neurofoilSummary: input.summaryExtra || null,
    sourceLabel: payload.source_label,
    recorderUid,
    recordedAt: new Date().toISOString(),
  };
  const summaryBlob = new Blob([JSON.stringify(summaryDocument, null, 2)], {
    type: "application/json",
  });
  const storageRes = await uploadBlobToBucket(
    RESULTS_BUCKET,
    storagePath,
    summaryBlob,
    "application/json"
  );

  emitSync("benchmarks");
  const mapped = data
    ? mapBenchmarkRow(data as Record<string, unknown>)
    : {
        id,
        airfoilName: payload.airfoil_name,
        airfoilId: payload.airfoil_id,
        kind: payload.kind,
        alpha: payload.alpha,
        reynolds: payload.reynolds,
        cl: payload.cl,
        cd: payload.cd,
        ld: payload.ld,
        separationPct: payload.separation_pct,
        sourceLabel: payload.source_label,
        recorderUid,
        visibility: "public" as const,
        createdAtMs: Date.now(),
        storagePath,
        storageUrl: storageRes.ok ? storageRes.publicUrl : getBucketPublicUrl(RESULTS_BUCKET, storagePath),
      };

  return {
    ...mapped,
    storageWarning: storageRes.ok ? undefined : storageRes.error,
  };
}

export async function deleteBenchmarkRun(id: string, recorderUid?: string): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("benchmarks").delete().eq("id", id);
  if (error) {
    throw formatSupabaseError(error, "Could not delete benchmark run.");
  }
  const {
    data: { user },
  } = await client.auth.getUser();
  const ownerFolder = recorderUid || user?.id || "community";
  await removeObjectsFromBucket(RESULTS_BUCKET, [`${ownerFolder}/${id}.json`]);
  emitSync("benchmarks");
}

export function subscribePublicGlbModels(
  onData: (items: SharedGlbModelDoc[]) => void,
  onError?: (err: Error) => void
): () => void {
  if (!supabase) {
    onData([]);
    return () => {};
  }
  const client = supabase;
  let active = true;
  let latestItems: SharedGlbModelDoc[] = [];
  let fallbackTimer: number | null = null;
  let isSubscribed = false;

  const publishSorted = (items: SharedGlbModelDoc[]) => {
    latestItems = items.slice().sort((a, b) => b.createdAtMs - a.createdAtMs);
    onData(latestItems);
  };

  const fetchGlbModels = async () => {
    const { data, error } = await client
      .from("glb_models")
      .select("*")
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .limit(60);

    if (!active) return;
    if (error) {
      onError?.(formatSupabaseError(error, "Could not load saved 3D models."));
      return;
    }
    const items = (data || []).map((row) => mapGlbModelRow(row as Record<string, unknown>));
    publishSorted(items);
  };

  const startFallbackPolling = () => {
    if (typeof window === "undefined" || fallbackTimer !== null) return;
    fallbackTimer = window.setInterval(() => {
      if (active && !isSubscribed) {
        void fetchGlbModels();
      }
    }, 8000);
  };

  const stopFallbackPolling = () => {
    if (fallbackTimer !== null && typeof window !== "undefined") {
      window.clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  };

  void fetchGlbModels();

  const onLocalSync = (evt: Event) => {
    const detail = (evt as CustomEvent<{ scope?: string }>).detail;
    if (detail?.scope === "glb_models") {
      void fetchGlbModels();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener(SUPABASE_SYNC_EVENT, onLocalSync);
  }

  let bc: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      bc = new BroadcastChannel(SYNC_CHANNEL_NAME);
      bc.onmessage = (msg: MessageEvent<{ scope?: string }>) => {
        if (msg.data?.scope === "glb_models") {
          void fetchGlbModels();
        }
      };
    } catch {
      bc = null;
    }
  }

  const onVisibilityOrFocus = () => {
    if (!active) return;
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      void fetchGlbModels();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onVisibilityOrFocus);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityOrFocus);
  }

  const channelId = `public_glb_models_${Math.random().toString(36).slice(2, 8)}`;
  const channel = client
    .channel(channelId)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "glb_models" },
      (payload) => {
        if (!active) return;
        const eventType = payload.eventType;
        if (eventType === "DELETE") {
          const oldId = String((payload.old as Record<string, unknown> | undefined)?.id || "");
          if (oldId) {
            publishSorted(latestItems.filter((item) => item.id !== oldId));
          }
          void fetchGlbModels();
          return;
        }

        const nextRow = payload.new as Record<string, unknown> | undefined;
        if (nextRow && nextRow.id) {
          const mapped = mapGlbModelRow(nextRow);
          const isVisible = String(nextRow.visibility || "public") === "public";
          const withoutCurrent = latestItems.filter((item) => item.id !== mapped.id);
          publishSorted(isVisible ? [mapped, ...withoutCurrent] : withoutCurrent);
        }
        void fetchGlbModels();
      }
    )
    .subscribe((status) => {
      if (!active) return;
      if (status === "SUBSCRIBED") {
        isSubscribed = true;
        stopFallbackPolling();
        void fetchGlbModels();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        isSubscribed = false;
        startFallbackPolling();
      }
    });

  return () => {
    active = false;
    stopFallbackPolling();
    if (typeof window !== "undefined") {
      window.removeEventListener(SUPABASE_SYNC_EVENT, onLocalSync);
      window.removeEventListener("focus", onVisibilityOrFocus);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityOrFocus);
    }
    if (bc) {
      try {
        bc.close();
      } catch {
        // ignore close errors
      }
    }
    void client.removeChannel(channel);
  };
}

export async function uploadSharedGlbModel(input: {
  file: Blob;
  name: string;
  filename: string;
  fileSizeBytes?: number;
  calibration: AeroCalibration;
  bounds: BoundingBoxDims;
  uploaderName?: string;
}): Promise<SharedGlbModelDoc> {
  const client = requireSupabase();
  const {
    data: { user },
  } = await client.auth.getUser();
  const verifiedUid = user?.id || "";
  const userFullName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined) ||
    "";

  const cleanName = input.name.trim().slice(0, 80) || "Custom 3D Model";
  const cleanFile = input.filename.trim().slice(0, 120) || `${cleanName.replace(/\s+/g, "_")}.glb`;
  const uploaderName =
    (input.uploaderName?.trim() || userFullName || "Community").slice(0, 60) || "Community";
  const cleanCalibration = sanitizeCalibration(input.calibration);
  const cleanBounds: BoundingBoxDims = {
    x: Number((input.bounds.x > 0 ? input.bounds.x : 1).toFixed(4)),
    y: Number((input.bounds.y > 0 ? input.bounds.y : 0.3).toFixed(4)),
    z: Number((input.bounds.z > 0 ? input.bounds.z : 0.6).toFixed(4)),
  };

  const id = makeValidDocId("glb", cleanName);
  const ownerFolder = verifiedUid || "community";
  const storagePath = `${ownerFolder}/${id}.glb`;

  const storageRes = await uploadBlobToBucket(
    MODELS_BUCKET,
    storagePath,
    input.file,
    "model/gltf-binary"
  );
  if (!storageRes.ok) {
    throw new Error(storageRes.error || "Could not upload 3D model file.");
  }

  const storageUrl = storageRes.publicUrl || getBucketPublicUrl(MODELS_BUCKET, storagePath);
  const fileSizeBytes = Math.trunc(Math.max(1, input.fileSizeBytes || input.file.size || 1));

  const payload = {
    id,
    name: cleanName,
    filename: cleanFile,
    file_size_bytes: fileSizeBytes,
    model_class: cleanCalibration.modelClass,
    nose_axis: cleanCalibration.noseAxis,
    up_axis: cleanCalibration.upAxis,
    calibration: cleanCalibration,
    bounds: cleanBounds,
    uploader_name: uploaderName,
    uploader_uid: verifiedUid,
    visibility: "public" as const,
    storage_path: storagePath,
    storage_url: storageUrl,
  };

  const { data, error } = await client
    .from("glb_models")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    await removeObjectsFromBucket(MODELS_BUCKET, [storagePath]);
    throw formatSupabaseError(error, "Could not save 3D model record.");
  }

  emitSync("glb_models");
  return data
    ? mapGlbModelRow(data as Record<string, unknown>)
    : {
        id,
        name: cleanName,
        filename: cleanFile,
        fileSizeBytes,
        modelClass: cleanCalibration.modelClass,
        noseAxis: cleanCalibration.noseAxis,
        upAxis: cleanCalibration.upAxis,
        calibration: cleanCalibration,
        bounds: cleanBounds,
        uploaderName,
        uploaderUid: verifiedUid,
        visibility: "public" as const,
        createdAtMs: Date.now(),
        storagePath,
        storageUrl,
      };
}

export async function updateSharedGlbModelCalibration(
  id: string,
  calibration: AeroCalibration
): Promise<void> {
  if (!supabase || !id) return;
  const cleanCalibration = sanitizeCalibration(calibration);
  const { error } = await supabase
    .from("glb_models")
    .update({
      model_class: cleanCalibration.modelClass,
      nose_axis: cleanCalibration.noseAxis,
      up_axis: cleanCalibration.upAxis,
      calibration: cleanCalibration,
    })
    .eq("id", id);
  if (error) {
    throw formatSupabaseError(error, "Could not update 3D model calibration.");
  }
  emitSync("glb_models");
}

export async function downloadSharedGlbBuffer(
  doc: Pick<SharedGlbModelDoc, "storagePath" | "storageUrl">
): Promise<ArrayBuffer> {
  if (supabase && doc.storagePath) {
    try {
      const { data, error } = await supabase.storage
        .from(MODELS_BUCKET)
        .download(doc.storagePath);
      if (!error && data) {
        return await data.arrayBuffer();
      }
    } catch {
      // fall back to public URL fetch
    }
  }
  if (!doc.storageUrl) {
    throw new Error("3D model file location is unavailable.");
  }
  const res = await fetch(doc.storageUrl);
  if (!res.ok) {
    throw new Error(`Could not fetch 3D model (${res.status}).`);
  }
  return await res.arrayBuffer();
}

export async function deleteSharedGlbModel(
  id: string,
  uploaderUid?: string,
  storagePath?: string
): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("glb_models").delete().eq("id", id);
  if (error) {
    throw formatSupabaseError(error, "Could not delete 3D model.");
  }
  const {
    data: { user },
  } = await client.auth.getUser();
  const ownerFolder = uploaderUid || user?.id || "community";
  const targetPath = storagePath || `${ownerFolder}/${id}.glb`;
  await removeObjectsFromBucket(MODELS_BUCKET, [targetPath]);
  emitSync("glb_models");
}

// Built-in Neutral Reference Baseline (symmetric NACA 0012 at Re ≈ 2,560)
export const DEFAULT_NEUTRAL_BASELINE: NeutralReferenceData = {
  label: "Neutral Baseline (NACA 0012)",
  sourceType: "builtin",
  airfoilName: "NACA 0012 (Neutral)",
  rows: [
    { alpha: -5, cl: -0.52, cd: 0.068, ld: -7.65, separationPct: 4 },
    { alpha: 0, cl: 0.0, cd: 0.052, ld: 0.0, separationPct: 0 },
    { alpha: 3, cl: 0.34, cd: 0.058, ld: 5.86, separationPct: 1 },
    { alpha: 6, cl: 0.65, cd: 0.072, ld: 9.03, separationPct: 3 },
    { alpha: 9, cl: 0.89, cd: 0.104, ld: 8.56, separationPct: 11 },
    { alpha: 12, cl: 0.96, cd: 0.165, ld: 5.82, separationPct: 28 },
    { alpha: 15, cl: 0.84, cd: 0.245, ld: 3.43, separationPct: 46 },
  ],
};

/**
 * Estimates a thin-airfoil + viscous baseline polar from any .dat airfoil geometry,
 * or parses an exported JSON / CSV telemetry or neural benchmark file.
 */
export function parseNeutralComparisonFile(text: string, filename: string): NeutralReferenceData {
  const lower = filename.toLowerCase();

  // 1. JSON format (AeroLab datasheet export or neural prediction array)
  if (lower.endsWith(".json")) {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [];
    const mapped: Array<NeutralReferenceData["rows"][number] | null> = arr.map(
      (item: Record<string, unknown>) => {
        const alpha = Number(item.alpha_deg ?? item.alpha ?? item.aoa ?? 0);
        const cl = Number(item.cl ?? item.CL ?? 0);
        const cd = Number(item.cd ?? item.CD ?? 0.05);
        const ld = Number(item.ld_ratio ?? item.ld ?? item.LD ?? (cd > 0.001 ? cl / cd : 0));
        const sep = Number(item.separation_pct ?? item.separationPct ?? 0);
        if (!Number.isFinite(alpha) || !Number.isFinite(cl) || !Number.isFinite(cd)) return null;
        return { alpha, cl, cd: Math.max(0.001, cd), ld, separationPct: sep };
      }
    );
    const rows = mapped.filter(
      (r): r is NeutralReferenceData["rows"][number] => r !== null
    );
    if (!rows.length) throw new Error("JSON reference file contains no valid alpha/CL/CD rows.");
    const firstFoil = String(arr[0]?.airfoil || filename.replace(/\.json$/i, ""));
    return {
      label: filename,
      sourceType: "file",
      airfoilName: firstFoil,
      rows: aggregatePolarRows(rows),
    };
  }

  // 2. CSV format (AeroLab datasheet CSV or neural benchmark table)
  if (lower.endsWith(".csv")) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error("CSV reference file needs a header row and data rows.");
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const idxA = headers.findIndex((h) => h.includes("alpha") || h === "aoa");
    const idxCl = headers.findIndex((h) => h === "cl" || h.startsWith("cl_"));
    const idxCd = headers.findIndex((h) => h === "cd" || h.startsWith("cd_"));
    const idxLd = headers.findIndex((h) => h.includes("ld"));
    const idxFoil = headers.findIndex((h) => h.includes("airfoil"));
    if (idxA < 0 || idxCl < 0 || idxCd < 0) {
      throw new Error("CSV file must include alpha, cl, and cd columns.");
    }
    const rows: NeutralReferenceData["rows"] = [];
    let detectedFoil = filename.replace(/\.csv$/i, "");
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      const alpha = Number(cols[idxA]);
      const cl = Number(cols[idxCl]);
      const cd = Number(cols[idxCd]);
      if (!Number.isFinite(alpha) || !Number.isFinite(cl) || !Number.isFinite(cd)) continue;
      const ld = idxLd >= 0 && Number.isFinite(Number(cols[idxLd])) ? Number(cols[idxLd]) : cd > 0.001 ? cl / cd : 0;
      if (idxFoil >= 0 && cols[idxFoil]) detectedFoil = cols[idxFoil];
      rows.push({ alpha, cl, cd: Math.max(0.001, cd), ld });
    }
    if (!rows.length) throw new Error("No numeric aerodynamic rows found in CSV file.");
    return {
      label: filename,
      sourceType: "file",
      airfoilName: detectedFoil,
      rows: aggregatePolarRows(rows),
    };
  }

  // 3. Airfoil .dat/.txt geometry file -> compute neutral surrogate polar from camber & thickness
  const { coords } = parseDatText(text);
  const { camberPct, thicknessPct } = computeAirfoilGeometryStats(coords);
  const foilTitle = filename.replace(/\.(dat|txt)$/i, "");
  return buildBaselineFromGeometry(foilTitle, camberPct, thicknessPct, "file", filename);
}

export function buildBaselineFromGeometry(
  airfoilName: string,
  camberPct: number,
  thicknessPct: number,
  sourceType: "builtin" | "file" | "airfoil" = "airfoil",
  label?: string
): NeutralReferenceData {
  const camber = camberPct / 100;
  const thick = thicknessPct / 100;
  const zeroLiftDeg = -camber * 105; // thin-airfoil ~1.05 deg per % camber
  const cd0 = 0.042 + 0.095 * thick;
  const alphas = [-5, 0, 3, 6, 9, 12, 15];
  const rows = alphas.map((alpha) => {
    const effDeg = alpha - zeroLiftDeg;
    const effRad = (effDeg * Math.PI) / 180;
    const stallFactor = Math.max(0, Math.abs(effDeg) - 10.5);
    const clRaw = 2 * Math.PI * 0.92 * Math.sin(effRad);
    const cl = Number((clRaw / (1 + 0.14 * stallFactor * stallFactor)).toFixed(3));
    const cd = Number((cd0 + 0.045 * cl * cl + 0.018 * stallFactor * stallFactor).toFixed(4));
    const ld = Number((cd > 0.001 ? cl / cd : 0).toFixed(2));
    return { alpha, cl, cd, ld };
  });
  return {
    label: label || `${airfoilName} Baseline`,
    sourceType,
    airfoilName,
    rows,
  };
}

function aggregatePolarRows(rows: NeutralReferenceData["rows"]): NeutralReferenceData["rows"] {
  const map = new Map<string, { alpha: number; cl: number; cd: number; ld: number; n: number }>();
  for (const r of rows) {
    const key = r.alpha.toFixed(1);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { alpha: r.alpha, cl: r.cl, cd: r.cd, ld: r.ld, n: 1 });
    } else {
      cur.cl += r.cl;
      cur.cd += r.cd;
      cur.ld += r.ld;
      cur.n += 1;
    }
  }
  return Array.from(map.values())
    .map((v) => ({
      alpha: v.alpha,
      cl: Number((v.cl / v.n).toFixed(4)),
      cd: Number((v.cd / v.n).toFixed(4)),
      ld: Number((v.ld / v.n).toFixed(3)),
    }))
    .sort((a, b) => a.alpha - b.alpha);
}

export function interpolateReferenceAtAlpha(
  ref: NeutralReferenceData,
  alpha: number
): { cl: number; cd: number; ld: number } | null {
  const rows = ref.rows;
  if (!rows.length) return null;
  if (rows.length === 1 || alpha <= rows[0].alpha) return rows[0];
  if (alpha >= rows[rows.length - 1].alpha) return rows[rows.length - 1];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (alpha >= a.alpha && alpha <= b.alpha) {
      const span = b.alpha - a.alpha;
      const t = span > 1e-6 ? (alpha - a.alpha) / span : 0;
      const cl = a.cl + (b.cl - a.cl) * t;
      const cd = a.cd + (b.cd - a.cd) * t;
      const ld = cd > 0.001 ? cl / cd : a.ld + (b.ld - a.ld) * t;
      return { cl, cd, ld };
    }
  }
  return rows[0];
}
