import { Platform } from "react-native";
import * as LegacyFileSystem from "expo-file-system/legacy";
import { getApiUrl } from "./query-client";

/**
 * Getting a stitch's files, whether or not the server still has it.
 *
 * Outputs live in the server's temp directory and the deployment is Cloud Run,
 * so a result URL stops working minutes after the container goes idle. The
 * device's own copy is the durable one; when something genuinely needs the
 * pixels server-side — rendering a PDF, trimming edges — the copy is sent back
 * up first.
 */

export interface RehydratedStitch {
  imageUrl: string;
  previewUrl: string;
  pdfUrl: string;
  dimensions: { width: number; height: number };
}

/**
 * Re-establish server-side state for a stitch from the device's copy.
 *
 * Returns fresh URLs that behave exactly like a just-finished job's.
 */
export async function rehydrateStitch(localImageUri: string): Promise<RehydratedStitch> {
  if (Platform.OS === "web") {
    throw new Error("Rehydrating is not available in the browser");
  }
  const url = new URL("/api/rehydrate", getApiUrl()).toString();
  const expoFetch = (await import("expo/fetch")).fetch;
  const ExpoFile = (await import("expo-file-system")).File;

  const formData = new FormData();
  formData.append("image", new ExpoFile(localImageUri) as any);

  const res = await expoFetch(url, { method: "POST", body: formData });
  if (!res.ok) {
    throw new Error(`Could not restore this stitch on the server (${res.status})`);
  }
  return (await res.json()) as RehydratedStitch;
}

function cacheUri(filename: string): string {
  const dir = LegacyFileSystem.cacheDirectory ?? "";
  return dir + (dir.endsWith("/") ? "" : "/") + filename;
}

/**
 * Download one of the server's output files into the cache directory.
 *
 * Streams to disk rather than going through base64 in JS — a stitched PNG runs
 * to tens of megabytes, and a base64 round trip holds all of it in memory as a
 * string as well as a buffer.
 */
export async function downloadOutput(urlPath: string, filename: string): Promise<string> {
  const url = new URL(urlPath, getApiUrl()).toString();
  const target = cacheUri(filename);
  const result = await LegacyFileSystem.downloadAsync(url, target);
  if (result.status !== 200) {
    throw new Error(`Download failed (${result.status})`);
  }
  return result.uri;
}

/**
 * A local PDF file for a stitch, built from whichever source still exists.
 *
 * `pdfUrlHint` is the URL the job reported. It is tried first because it costs
 * one request and usually works — the user shares a PDF right after stitching.
 * Once the container is gone that URL 404s, and the only remaining source of
 * the pixels is the device, so the image goes back up and the PDF is rendered
 * from that.
 */
export async function preparePdf(
  localImageUri: string | null,
  pdfUrlHint: string | null
): Promise<string> {
  const filename = `scrollstitch_${Date.now()}.pdf`;

  if (pdfUrlHint) {
    try {
      return await downloadOutput(pdfUrlHint, filename);
    } catch (err) {
      if (!localImageUri) throw err;
      console.warn("[stitch-files] PDF gone from the server, rebuilding it:", err);
    }
  }

  if (!localImageUri) {
    throw new Error("This stitch is no longer available");
  }
  const restored = await rehydrateStitch(localImageUri);
  return downloadOutput(restored.pdfUrl, filename);
}
