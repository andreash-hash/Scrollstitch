import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LegacyFileSystem from "expo-file-system/legacy";
import { pruneRecords, type StitchRecord } from "./library-retention";

/**
 * The stitch library — every finished stitch, kept on the device.
 *
 * Results used to exist only as URLs into the server's temp directory, and the
 * deployment runs on Cloud Run: the container is recycled once traffic stops
 * and replaced on every deploy, so those URLs are good for minutes. Leave the
 * app, come back, press Save, and the file the app was still pointing at had
 * been gone for an hour — "Failed to fetch file". Worse, the result lived only
 * in React state, so iOS suspending the app lost the stitch outright with no
 * way back to it.
 *
 * So the full-resolution image is pulled onto the device the moment the job
 * finishes, while the server certainly still has it, and everything after that
 * — displaying, saving to Photos, sharing a PDF — reads the local copy.
 */

const INDEX_KEY = "@scrollstitch/library_v1";
const DIR_NAME = "stitches";

/**
 * iOS gives an app a new container path on every update, so an absolute URI
 * stored today is a dead path after the next release. Records therefore hold
 * FILENAMES only and are resolved against the current document directory on
 * every read.
 */
function libraryDir(): string | null {
  const base = LegacyFileSystem.documentDirectory;
  if (!base) return null;
  return base + (base.endsWith("/") ? "" : "/") + DIR_NAME + "/";
}

export type { StitchRecord } from "./library-retention";
export {
  MAX_STITCHES,
  MAX_LIBRARY_BYTES,
  pruneRecords,
  libraryBytes,
  formatBytes,
} from "./library-retention";

async function readIndex(): Promise<StitchRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is StitchRecord =>
        !!r && typeof r.id === "string" && typeof r.imageFile === "string"
    );
  } catch {
    return [];
  }
}

async function writeIndex(records: StitchRecord[]): Promise<void> {
  try {
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(records));
  } catch {
    // Storage full or unavailable. The files are still on disk; the next
    // successful write picks the index back up.
  }
}

/** Absolute URI of a record's full-resolution image. */
export function stitchImageUri(record: StitchRecord): string {
  return (libraryDir() ?? "") + record.imageFile;
}

/** Absolute URI of the image to show on screen — the preview when there is one. */
export function stitchDisplayUri(record: StitchRecord): string {
  return (libraryDir() ?? "") + (record.previewFile ?? record.imageFile);
}

/** Saved stitches, newest first. */
export async function loadLibrary(): Promise<StitchRecord[]> {
  const records = await readIndex();
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

async function removeFiles(...names: (string | null)[]): Promise<void> {
  const dir = libraryDir();
  if (!dir) return;
  for (const name of names) {
    if (!name) continue;
    try {
      await LegacyFileSystem.deleteAsync(dir + name, { idempotent: true });
    } catch {
      // Already gone, or the directory was cleared by the OS
    }
  }
}

export interface SaveStitchInput {
  /** Absolute URL of the full-resolution output on the server. */
  imageUrl: string;
  /** Absolute URL of the downscaled preview, when the server made one. */
  previewUrl: string | null;
  width: number;
  height: number;
  frameCount: number;
  selectedFrames: number;
  gapCount: number;
  warnings: string[];
}

/**
 * Pull a finished stitch onto the device and add it to the library.
 *
 * Returns null rather than throwing: a stitch the user can see on screen must
 * never fail because it could not be filed away. The caller falls back to the
 * server URLs, which still work for as long as the container lives.
 */
export async function saveStitchToLibrary(
  input: SaveStitchInput
): Promise<StitchRecord | null> {
  if (Platform.OS === "web") return null; // browser downloads instead
  const dir = libraryDir();
  if (!dir) return null;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const ext = input.imageUrl.includes(".jpg") ? "jpg" : "png";
  const imageFile = `${id}.${ext}`;
  let previewFile: string | null = null;

  try {
    await LegacyFileSystem.makeDirectoryAsync(dir, { intermediates: true });

    const image = await LegacyFileSystem.downloadAsync(input.imageUrl, dir + imageFile);
    if (image.status !== 200) throw new Error(`image download failed (${image.status})`);

    // Only when the server actually made a downscaled copy: for a stitch short
    // enough to display directly, a second file would be the same pixels twice.
    if (input.previewUrl && input.previewUrl !== input.imageUrl) {
      const name = `${id}_preview.jpg`;
      const preview = await LegacyFileSystem.downloadAsync(input.previewUrl, dir + name);
      if (preview.status === 200) previewFile = name;
    }

    const info = await LegacyFileSystem.getInfoAsync(dir + imageFile);
    const bytes = info.exists ? info.size : 0;

    const record: StitchRecord = {
      id,
      createdAt: Date.now(),
      imageFile,
      previewFile,
      width: input.width,
      height: input.height,
      bytes,
      frameCount: input.frameCount,
      selectedFrames: input.selectedFrames,
      gapCount: input.gapCount,
      warnings: input.warnings,
    };

    const { keep, drop } = pruneRecords([record, ...(await readIndex())]);
    await writeIndex(keep);
    for (const stale of drop) await removeFiles(stale.imageFile, stale.previewFile);

    return record;
  } catch (err) {
    console.warn("[library] could not save stitch:", err);
    // Half-written files would otherwise sit there forever, counted by nothing.
    await removeFiles(imageFile, previewFile);
    return null;
  }
}

/** Forget one stitch and delete its files. */
export async function deleteStitch(id: string): Promise<StitchRecord[]> {
  const records = await readIndex();
  const target = records.find((r) => r.id === id);
  const remaining = records.filter((r) => r.id !== id);
  await writeIndex(remaining);
  if (target) await removeFiles(target.imageFile, target.previewFile);
  return remaining.sort((a, b) => b.createdAt - a.createdAt);
}

/** Forget every stitch and delete the whole directory. */
export async function clearLibrary(): Promise<void> {
  const records = await readIndex();
  await writeIndex([]);
  for (const record of records) await removeFiles(record.imageFile, record.previewFile);
}
