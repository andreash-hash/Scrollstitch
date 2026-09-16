/**
 * What the stitch library keeps, and what it throws away.
 *
 * Deliberately free of React Native and Expo imports: this is the rule that
 * deletes the user's saved stitches, so it is kept where it can be tested
 * directly in Node rather than only through a running app.
 */

export interface StitchRecord {
  id: string;
  /** Epoch ms the stitch was finished. */
  createdAt: number;
  /** Filename of the full-resolution image inside the library directory. */
  imageFile: string;
  /** Downscaled display copy, when the stitch was too tall for iOS to decode. */
  previewFile: string | null;
  width: number;
  height: number;
  /** Size on disk of the full-resolution image. */
  bytes: number;
  frameCount: number;
  selectedFrames: number;
  gapCount: number;
  warnings: string[];
}

/**
 * How much of the user's phone the library may occupy.
 *
 * A tall stitch is tens of megabytes, so an uncapped library would quietly
 * become the largest thing on the device. Both limits are enforced; whichever
 * bites first wins, and the oldest stitches go.
 */
export const MAX_STITCHES = 20;
export const MAX_LIBRARY_BYTES = 500 * 1024 * 1024;

/**
 * Split records into the ones to keep and the ones to drop, newest first.
 */
export function pruneRecords(
  records: StitchRecord[],
  maxCount: number = MAX_STITCHES,
  maxBytes: number = MAX_LIBRARY_BYTES
): { keep: StitchRecord[]; drop: StitchRecord[] } {
  const newestFirst = [...records].sort((a, b) => b.createdAt - a.createdAt);
  const keep: StitchRecord[] = [];
  const drop: StitchRecord[] = [];
  let total = 0;

  for (const record of newestFirst) {
    // The newest stitch is always kept, even when it alone blows the budget —
    // it is the one the user is looking at, and dropping it would delete a
    // result the moment it was made.
    const first = keep.length === 0;
    if (!first && (keep.length >= maxCount || total + record.bytes > maxBytes)) {
      drop.push(record);
      continue;
    }
    keep.push(record);
    total += record.bytes;
  }

  return { keep, drop };
}

/** Total bytes held by a set of records. */
export function libraryBytes(records: StitchRecord[]): number {
  return records.reduce((sum, r) => sum + r.bytes, 0);
}

/** "12.4 MB" — for the storage line in the library UI. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
