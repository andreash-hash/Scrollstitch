import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The job that was running when the app last went away.
 *
 * Processing happens on the server and the client only polls, so leaving the
 * app mid-job is fine — a push notification says when it is done. But iOS
 * suspends the app within seconds of backgrounding and may kill it outright,
 * and the poll loop lived only in React state: come back to a killed app and
 * the finished stitch had nobody to collect it. It was never downloaded, and
 * once the server's container recycled it was gone for good.
 *
 * Remembering the job id across launches lets the app walk back up to a stitch
 * that finished while it was asleep, and file it into the library.
 */

const PENDING_KEY = "@scrollstitch/pending_job";

/**
 * How long a remembered job is worth chasing.
 *
 * The server drops a job's progress record after 30 minutes, so past that
 * there is nothing to resume to — and the container holding the output may
 * well have been recycled before then.
 */
export const PENDING_JOB_TTL_MS = 30 * 60 * 1000;

export interface PendingJob {
  jobId: string;
  startedAt: number;
}

export async function rememberPendingJob(jobId: string): Promise<void> {
  try {
    const value: PendingJob = { jobId, startedAt: Date.now() };
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable — resuming is a bonus, not a requirement
  }
}

export async function forgetPendingJob(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch {}
}

/** The remembered job, if there is one and it is still worth chasing. */
export async function loadPendingJob(
  now: number = Date.now()
): Promise<PendingJob | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingJob;
    if (!parsed?.jobId || typeof parsed.startedAt !== "number") return null;
    if (now - parsed.startedAt > PENDING_JOB_TTL_MS) {
      await forgetPendingJob();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
