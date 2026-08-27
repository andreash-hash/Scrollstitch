import React, { useState, useEffect, useRef, useCallback } from "react";
import { useAppContext } from "@/contexts/AppContext";
import { useRouter } from "expo-router";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  Platform,
  Dimensions,
  StatusBar,
  ActivityIndicator,
  AccessibilityInfo,
  Modal,
  Linking,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather, Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as LegacyFileSystem from "expo-file-system/legacy";
import { Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import * as VideoThumbnails from "expo-video-thumbnails";
import * as ImageManipulator from "expo-image-manipulator";
import Animated, { Easing,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withTiming,
  withSequence,
  FadeIn,
  FadeInDown,
} from "react-native-reanimated";
import { getApiUrl } from "@/lib/query-client";
import {
  initialTotalMs,
  reviseTotalMs,
  nextShownMs,
  allowedDropMs,
  formatEta,
} from "@/lib/eta";
import { getPushToken } from "@/lib/push";
import { readableMediaError, technicalErrorCode } from "@/lib/mediaErrors";
import { useSubscription, REVENUECAT_ENTITLEMENT_IDENTIFIER } from "@/lib/revenuecat";
import * as StoreReview from "expo-store-review";
import Colors from "@/constants/colors";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const C = Colors.dark;

type ProcessingStage =
  | "idle"
  | "extracting"
  | "filtering"
  | "uploading"
  | "processing"
  | "complete"
  | "error";

interface ProcessingResult {
  imageUrl: string;
  /** Downscaled copy for on-screen display — iOS refuses to decode very
   * large images, so tall stitches would otherwise render black. */
  previewUrl?: string;
  pdfUrl: string;
  frameCount: number;
  uniqueFrames: number;
  selectedFrames?: number;
  gapCount?: number;
  warnings?: string[];
  dimensions: { width: number; height: number };
}

// Sampling has to be dense enough that even a fast flick leaves shared content
// between consecutive frames: a flick moves 1-1.5 screen heights per 300ms, so
// 300ms lost every seam and 150ms still lost the fastest ones. At 100ms even a
// hard flick overlaps, and the surplus on slow sections costs nothing — dedup
// and greedy selection discard it (a recent run: 65 frames in, 23 stitched).
// Long videos widen the interval so the frame count stays bounded.
const EXTRACT_INTERVAL_MS = 100;
const MAX_EXTRACT_FRAMES = 300;
/** Frames per upload request — small enough to retry cheaply, large enough
 * that the per-request overhead stays negligible. */
const UPLOAD_BATCH_SIZE = 25;

function extractionIntervalMs(durationMs: number): number {
  return Math.max(EXTRACT_INTERVAL_MS, Math.ceil(durationMs / MAX_EXTRACT_FRAMES));
}

const STAGE_LABELS: Record<string, string> = {
  "Processing": "Preparing frames...",
  "Validating frames": "Checking frames...",
  "Removing duplicates": "Detecting duplicate frames...",
  "Removing sticky headers": "Removing sticky headers & footers...",
  "Selecting frames": "Selecting the best frames...",
  "Stitching frames": "Stitching frames together...",
  "Generating PDF": "Generating PDF...",
};

function PulsingDot() {
  const opacity = useSharedValue(0.3);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 600 }),
        withTiming(0.3, { duration: 600 })
      ),
      -1
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.pulsingDot, style]} />;
}

function ProgressBar({ progress }: { progress: number }) {
  const animatedWidth = useSharedValue(0);
  useEffect(() => {
    animatedWidth.value = withTiming(progress * 100, {
      duration: 400,
      easing: Easing.out(Easing.cubic),
    });
  }, [progress]);
  const barStyle = useAnimatedStyle(() => ({
    width: `${animatedWidth.value}%` as any,
  }));
  return (
    <View
      style={styles.progressBarContainer}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
    >
      <Animated.View style={[styles.progressBarFill, barStyle]} />
    </View>
  );
}

function ActivityOverlay({ label }: { label: string }) {
  const shimmer = useSharedValue(0);
  useEffect(() => {
    shimmer.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1
    );
  }, []);
  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + shimmer.value * 0.6,
  }));
  return (
    <View style={styles.activityOverlay}>
      <Animated.View style={shimmerStyle}>
        <ActivityIndicator size="small" color={C.accent} />
      </Animated.View>
      <Text style={styles.activityText}>{label}</Text>
    </View>
  );
}

async function extractFramesFromVideoWeb(
  uri: string,
  onProgress: (current: number, total: number) => void
): Promise<string[]> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.src = uri;
    video.muted = true;
    video.playsInline = true;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    // Tiny probe canvas for detecting blank (undecoded) frames — iOS Safari
    // can fire `seeked` before the frame is actually paintable.
    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = 16;
    probeCanvas.height = 16;
    const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
    const frameUris: string[] = [];
    let intervalMs = EXTRACT_INTERVAL_MS;
    let currentFrame = 0;
    let totalFrames = 0;

    const frameLooksBlank = (): boolean => {
      if (!probeCtx || canvas.width === 0) return false;
      probeCtx.drawImage(canvas, 0, 0, 16, 16);
      const { data } = probeCtx.getImageData(0, 0, 16, 16);
      let min = 255;
      let max = 0;
      for (let i = 0; i < data.length; i += 4) {
        const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (g < min) min = g;
        if (g > max) max = g;
      }
      // Uniform AND near-black = decoder glitch, not page content
      return max - min < 6 && max < 16;
    };

    const captureFrame = (): boolean => {
      if (!ctx || video.videoWidth === 0) return false;
      // Cap at 540px wide — full resolution causes memory exhaustion with 100+ frames.
      // 540px is still plenty for server dedup (8×8) and overlap detection (64px sample).
      const scale = Math.min(1, 540 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (frameLooksBlank()) return false;
      frameUris.push(canvas.toDataURL("image/jpeg", 0.8));
      return true;
    };

    const advance = () => {
      onProgress(currentFrame + 1, totalFrames);
      currentFrame++;
      seekNext();
    };

    const seekNext = () => {
      if (currentFrame >= totalFrames) {
        video.src = "";
        resolve(frameUris);
        return;
      }
      video.currentTime = (currentFrame * intervalMs) / 1000;
    };

    video.addEventListener("loadedmetadata", () => {
      intervalMs = extractionIntervalMs(video.duration * 1000);
      totalFrames = Math.max(1, Math.ceil((video.duration * 1000) / intervalMs));
      seekNext();
    });

    video.addEventListener("seeked", () => {
      if (captureFrame()) {
        advance();
        return;
      }
      // Blank/undecoded — give the decoder one more paint cycle, then move on
      // (skipping the frame if it is still blank).
      setTimeout(() => {
        captureFrame();
        advance();
      }, 80);
    });

    video.addEventListener("error", () => resolve(frameUris));
    video.load();
  });
}

async function extractFramesFromVideo(
  uri: string,
  durationMs: number,
  onProgress: (current: number, total: number) => void
): Promise<string[]> {
  if (Platform.OS === "web") {
    return extractFramesFromVideoWeb(uri, onProgress);
  }

  const intervalMs = extractionIntervalMs(durationMs);
  const totalFrames = Math.ceil(durationMs / intervalMs);
  const frameUris: string[] = [];

  // A frame that will not render is normal — a seek past the end, a corrupt
  // sample — and dropping it is the right call. Dropping the *reason* is not.
  // Swallowing every failure here is what left "Processing Failed" with nothing
  // behind it to explain: when a video cannot be read at all, every iteration
  // throws the same diagnosis and all of them were discarded.
  let firstFailure: unknown = null;

  for (let i = 0; i < totalFrames; i++) {
    const time = i * intervalMs;
    try {
      const thumb = await VideoThumbnails.getThumbnailAsync(uri, {
        time,
        quality: 0.7,
      });
      frameUris.push(thumb.uri);
    } catch (err) {
      if (firstFailure === null) firstFailure = err;
    }
    onProgress(i + 1, totalFrames);
  }

  // Nothing came out. Hand back why rather than a generic count of zero, so the
  // caller can tell "this file is not readable" from "this video has no usable
  // frames" and say something the reader can act on.
  if (frameUris.length === 0 && firstFailure !== null) {
    throw firstFailure;
  }

  return frameUris;
}

const SENSITIVITY_PRESETS = {
  fine:     { label: "Fine",     value: 0.85, desc: "Captures more frames" },
  balanced: { label: "Balanced", value: 0.92, desc: "Default" },
  fast:     { label: "Fast",     value: 0.97, desc: "Fewer frames, quicker" },
} as const;
type SensitivityKey = keyof typeof SENSITIVITY_PRESETS;

// Web: draw to a 16×32 canvas (taller = more sensitive to vertical scroll) and
// return grayscale pixel values as hex string (512 pixels × 2 hex chars = 1024 chars).
function getFrameThumbnailHashWeb(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    // document.createElement — `Image` is shadowed by the expo-image import
    const img = document.createElement("img");
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(""); return; }
        ctx.drawImage(img, 0, 0, 16, 32);
        const { data } = ctx.getImageData(0, 0, 16, 32);
        let hash = "";
        for (let i = 0; i < data.length; i += 4) {
          const gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
          hash += gray.toString(16).padStart(2, "0");
        }
        resolve(hash);
      } catch {
        resolve("");
      }
    };
    img.onerror = () => resolve("");
    img.src = dataUrl;
  });
}

// Extracts the raw scan data bytes from a JPEG base64 string (skips the fixed header)
// and returns them as a "J"-prefixed hex string. This bypasses the fixed JPEG header
// (~85% of the file is always identical) and compares only the actual image content.
function jpegScanHash(base64: string): string {
  try {
    const bin = atob(base64);
    for (let i = 0; i < bin.length - 3; i++) {
      if (bin.charCodeAt(i) === 0xFF && bin.charCodeAt(i + 1) === 0xDA) {
        // Found SOS marker. Skip SOS segment header (length field at i+2..i+3).
        const sosSegLen = (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3);
        const scanStart = i + 2 + sosSegLen;
        let hex = "J";
        for (let j = scanStart; j < bin.length - 2; j++) {
          const b = bin.charCodeAt(j);
          // Handle byte-stuffing: 0xFF 0x00 → real 0xFF in data; 0xFF 0xD9 = EOI
          if (b === 0xFF) {
            const n = bin.charCodeAt(j + 1);
            if (n === 0xD9) break; // end of image
            if (n === 0x00) { hex += "ff"; j++; continue; }
          }
          hex += b.toString(16).padStart(2, "0");
        }
        return hex;
      }
    }
    return "J" + base64; // fallback: no SOS found, use full string
  } catch {
    return "";
  }
}

async function getFrameThumbnailHash(uri: string): Promise<string> {
  if (Platform.OS === "web") {
    return getFrameThumbnailHashWeb(uri);
  }
  try {
    // 16×32: taller hash = more sensitive to vertical scrolling.
    // 15% quality: enough detail for AC coefficients to differ between text blocks.
    // 3s timeout: manipulateAsync can hang indefinitely on low-memory devices.
    const timeout = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("manipulate timeout")), 3000)
    );
    const manip = ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 16, height: 32 } }],
      { compress: 0.15, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    const result = await Promise.race([manip, timeout]);
    if (!result) return "";
    return jpegScanHash((result as ImageManipulator.ImageResult).base64 || "");
  } catch (e: any) {
    if (e?.message !== "manipulate timeout") {
      console.warn("getFrameThumbnailHash error:", e?.message);
    }
    return "";
  }
}

function compareHashes(a: string, b: string): number {
  if (!a || !b) return 0;

  // Web: 1024-char hex string (16×32 pixels × 2 hex chars) → mean absolute pixel diff
  if (a.length === 1024 && b.length === 1024) {
    let totalDiff = 0;
    for (let i = 0; i < 512; i++) {
      const va = parseInt(a.slice(i * 2, i * 2 + 2), 16);
      const vb = parseInt(b.slice(i * 2, i * 2 + 2), 16);
      totalDiff += Math.abs(va - vb);
    }
    return 1 - totalDiff / (255 * 512);
  }

  // Native: "J"-prefixed hex string of JPEG scan data (skips fixed header).
  // Identical frames → identical scan bytes → similarity=1.0.
  // Blocks that scrolled in share the same bit-offset so hex chars align correctly.
  if (a.startsWith("J") && b.startsWith("J")) {
    const aHex = a.slice(1);
    const bHex = b.slice(1);
    const len = Math.min(aHex.length, bHex.length);
    if (len === 0) return 0;
    let matches = 0;
    for (let i = 0; i < len; i++) {
      if (aHex[i] === bHex[i]) matches++;
    }
    return matches / Math.max(aHex.length, bHex.length);
  }

  // Fallback: character-level similarity on raw strings
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let matches = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / Math.max(a.length, b.length);
}

async function clientDeduplicateFrames(
  uris: string[],
  threshold: number,
  onProgress: (checked: number, total: number) => void
): Promise<string[]> {
  if (uris.length <= 1) return uris;

  const kept: string[] = [uris[0]];
  let lastHash = await getFrameThumbnailHash(uris[0]);
  onProgress(1, uris.length);

  // If the first hash fails (e.g. manipulator hangs/crashes on this device),
  // skip client dedup entirely — the server's perceptual dedup will handle it.
  if (!lastHash) {
    console.log("Client dedup: first hash empty — skipping, server will dedup");
    for (let i = 1; i < uris.length; i++) onProgress(i + 1, uris.length);
    return uris;
  }

  const sims: number[] = [];
  for (let i = 1; i < uris.length; i++) {
    const hash = await getFrameThumbnailHash(uris[i]);

    // If hash is empty (manipulation timed out / crashed for this frame):
    // - If we have a valid reference: skip this frame (treat as duplicate).
    //   A frame we cannot hash is likely identical or nearly identical to the
    //   previous one (same content = same decode difficulty). Server dedup
    //   will catch any genuine unique frames that we drop here.
    // - If we have no valid reference yet (lastHash also empty): keep the frame
    //   and keep searching for the first successful hash.
    if (!hash) {
      if (lastHash) {
        // drop the unhashable frame — treat as similar to previous
      } else {
        kept.push(uris[i]); // no reference yet, keep and continue
      }
      onProgress(i + 1, uris.length);
      continue;
    }

    if (!lastHash) {
      // First valid hash after initial failures — always keep and set as reference
      kept.push(uris[i]);
      lastHash = hash;
      onProgress(i + 1, uris.length);
      continue;
    }

    const similarity = compareHashes(lastHash, hash);
    sims.push(Math.round(similarity * 100) / 100);
    if (similarity < threshold) {
      kept.push(uris[i]);
      lastHash = hash;
    }
    onProgress(i + 1, uris.length);
  }
  const min = sims.length ? Math.min(...sims) : 0;
  const max = sims.length ? Math.max(...sims) : 0;
  const avg = sims.length ? sims.reduce((s, v) => s + v, 0) / sims.length : 0;
  console.log(`Dedup sims — min:${min.toFixed(2)} avg:${avg.toFixed(2)} max:${max.toFixed(2)} threshold:${threshold} kept:${kept.length}/${uris.length}`);
  return kept;
}

/** How often the countdown is refreshed. */
const ETA_TICK_MS = 500;

const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["videos"],
  quality: 1,
};

/**
 * Offer the fix while it is still cheap — before a recording has been chosen.
 *
 * Continuing is a real option, not a formality: a recording inside the selected
 * set works fine, and someone who deliberately shares a few photos with an app
 * should not be forced to widen that to use it.
 */
function confirmLimitedAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Limited photo access",
      "ScrollStitch can only open the photos you have selected. The picker will " +
        "still show everything, but recordings outside your selection cannot be " +
        "read.",
      [
        { text: "Pick anyway", style: "cancel", onPress: () => resolve(false) },
        { text: "Open Settings", onPress: () => resolve(true) },
      ],
      { cancelable: false }
    );
  });
}

/**
 * Ask before re-opening the picker, because the retry costs a second selection.
 *
 * Silently reopening a picker the reader just used reads as the app losing
 * their choice. Saying why first turns the same two taps into a step.
 */
function confirmSlowExport(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "One more tap",
      "That recording has been edited or trimmed, so it needs converting before " +
        "it can be read. Choose it once more and this will take a little longer " +
        "than usual.",
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Choose again", onPress: () => resolve(true) },
      ],
      { cancelable: false }
    );
  });
}

/** "READ" plus Apple's own identifier when the error carries one. */
function withDetail(step: string, err: unknown): string {
  const detail = technicalErrorCode(err);
  return detail ? `${step} · ${detail}` : step;
}

function formatRenewalDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function openManageSubscriptions() {
  if (Platform.OS === "ios") {
    Linking.openURL("itms-apps://apps.apple.com/account/subscriptions");
  } else if (Platform.OS === "android") {
    Linking.openURL("https://play.google.com/store/account/subscriptions");
  }
}

export default function ScrollStitchScreen() {
  const insets = useSafeAreaInsets();
  const {
    isPro,
    daysSinceFirstLaunch,
    winBackShown,
    reviewPrompted,
    recordSuccessfulStitch,
    markWinBackShown,
    markReviewPrompted,
  } = useAppContext();
  const {
    customerInfo,
    restore,
    isRestoring,
    customerInfoIsError,
    customerInfoIsLoading,
    refetchCustomerInfo,
    annualPackage,
    hasAnnualOrLifetime,
    purchase,
    isPurchasing,
  } = useSubscription();
  const router = useRouter();
  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [result, setResult] = useState<ProcessingResult | null>(null);
  /** Limited-access notice is worth saying once a launch, not once a pick. */
  const limitedNoticeShownRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState("");
  /**
   * Which step gave up, shown under the message.
   *
   * Two builds were spent fixing the wrong call because a failure screen that
   * names no step is the same screen whatever went wrong: the first fix guarded
   * one call out of four and looked identical in a screenshot to no fix at all.
   * A short code costs the reader nothing and ends the guessing.
   */
  const [errorCode, setErrorCode] = useState("");
  const [frameCount, setFrameCount] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [sensitivity, setSensitivity] = useState<SensitivityKey>("balanced");
  const [outputQuality, setOutputQuality] = useState<"png" | "jpeg">("png");
  const [eta, setEta] = useState<string | null>(null);
  /** True once a job is registered for a completion push. */
  const [canLeaveApp, setCanLeaveApp] = useState(false);
  const [cropTop, setCropTop] = useState(0);
  const [cropBottom, setCropBottom] = useState(0);
  const [isCropping, setIsCropping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [showWinBack, setShowWinBack] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fakeTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef(0);
  const statusTextRef = useRef("");
  const startTimeRef = useRef(0);
  /** Up-front guess from the frame count, before anything has been measured. */
  const etaPriorRef = useRef(0);
  /** Current best estimate of the job's total duration. */
  const etaTotalRef = useRef(0);
  /** Last figure shown, so the countdown never jumps back up. */
  const etaShownRef = useRef<number | null>(null);
  /** Progress at the previous tick — a quiet stage drains the budget slower. */
  const etaLastProgressRef = useRef(-1);
  const etaTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const buttonScale = useSharedValue(1);

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  const buttonAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const advanceProgress = useCallback((value: number) => {
    const next = Math.max(progressRef.current, value);
    progressRef.current = next;
    setProgress(next);

    // Only revise the estimate of the TOTAL here. What the user sees is driven
    // by the ticker below, so the number keeps falling between progress
    // updates instead of freezing whenever a slow stage goes quiet.
    if (next > 0.02 && next < 0.99 && startTimeRef.current > 0) {
      etaTotalRef.current = reviseTotalMs(
        etaTotalRef.current,
        Date.now() - startTimeRef.current,
        next,
        etaPriorRef.current
      );
    }
  }, []);

  const stopEtaTick = useCallback(() => {
    if (etaTickRef.current) {
      clearInterval(etaTickRef.current);
      etaTickRef.current = null;
    }
    etaShownRef.current = null;
    setEta(null);
  }, []);

  /**
   * Drive the visible countdown off the clock rather than off progress.
   *
   * Two rules make it feel honest: it never increases, and it keeps falling
   * while a slow stage reports nothing. Between them the number behaves like a
   * countdown instead of a guess being revised upward in public. When the
   * estimate runs out before the job does, it says so plainly rather than
   * sitting at "~0s".
   */
  const startEtaTick = useCallback(() => {
    if (etaTickRef.current) return;
    etaTickRef.current = setInterval(() => {
      if (startTimeRef.current === 0) return;

      if (progressRef.current >= 0.99) {
        setEta(null);
        return;
      }

      const advanced = progressRef.current > etaLastProgressRef.current;
      etaLastProgressRef.current = progressRef.current;

      const remaining = etaTotalRef.current - (Date.now() - startTimeRef.current);
      const next = nextShownMs(
        etaShownRef.current,
        remaining,
        allowedDropMs(ETA_TICK_MS, advanced)
      );
      etaShownRef.current = next;
      // Out of budget but still working — say so rather than counting "~0s".
      setEta(next < 1000 ? "Finishing up..." : formatEta(next));
    }, ETA_TICK_MS);
  }, []);

  const stopFakeTick = useCallback(() => {
    if (fakeTickRef.current) {
      clearInterval(fakeTickRef.current);
      fakeTickRef.current = null;
    }
  }, []);

  const startFakeTick = useCallback((from: number, to: number, durationMs: number) => {
    stopFakeTick();
    const steps = Math.ceil(durationMs / 80);
    const increment = (to - from) / steps;
    let current = from;
    fakeTickRef.current = setInterval(() => {
      current = Math.min(current + increment, to - 0.005);
      advanceProgress(current);
      if (current >= to - 0.005) stopFakeTick();
    }, 80);
  }, [advanceProgress, stopFakeTick]);

  const cleanupPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    stopFakeTick();
    stopEtaTick();
  }, [stopFakeTick, stopEtaTick]);

  useEffect(() => {
    return cleanupPolling;
  }, [cleanupPolling]);

  // Screen readers get nothing from an animated bar, and the poll rewrites the
  // status text several times a second — announce once per stage instead.
  useEffect(() => {
    if (stage === "idle") return;
    const message =
      stage === "complete"
        ? "Done. Your long screenshot is ready."
        : stage === "error"
          ? `Processing failed. ${errorMessage}`
          : statusTextRef.current || "Processing";
    AccessibilityInfo.announceForAccessibility(message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  /**
   * Runs once a stitch lands. Two prompts hang off this moment, and both are
   * deliberately gated: the App Store rate-limits review requests and ignores
   * extras silently, and a win-back shown too early just reads as a second
   * paywall.
   */
  const onStitchSucceeded = useCallback(
    async (res: ProcessingResult) => {
      const count = await recordSuccessfulStitch();

      // Offer the annual plan once, from day 3, only to weekly subscribers.
      if (
        daysSinceFirstLaunch >= 3 &&
        !winBackShown &&
        !hasAnnualOrLifetime &&
        annualPackage
      ) {
        setTimeout(() => setShowWinBack(true), 1200);
        return;
      }

      // Ask for a review only after the app has clearly worked: the second
      // clean stitch, and never alongside the win-back.
      const cleanResult = (res.gapCount ?? 0) === 0;
      if (count >= 2 && cleanResult && !reviewPrompted) {
        try {
          if (await StoreReview.hasAction()) {
            setTimeout(async () => {
              await StoreReview.requestReview();
              await markReviewPrompted();
            }, 1500);
          }
        } catch {
          // Review prompts are best-effort; never let one break the result screen.
        }
      }
    },
    [
      recordSuccessfulStitch,
      daysSinceFirstLaunch,
      winBackShown,
      hasAnnualOrLifetime,
      annualPackage,
      reviewPrompted,
      markReviewPrompted,
    ]
  );

  const acceptWinBack = useCallback(async () => {
    if (!annualPackage) return;
    try {
      await purchase(annualPackage);
      await markWinBackShown();
      setShowWinBack(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      if (!err?.userCancelled) {
        Alert.alert("Purchase failed", "Please try again.");
      }
    }
  }, [annualPackage, purchase, markWinBackShown]);

  const dismissWinBack = useCallback(async () => {
    await markWinBackShown();
    setShowWinBack(false);
  }, [markWinBackShown]);

  const pollProgress = useCallback(
    (jobId: string) => {
      const baseUrl = getApiUrl();
      const startTime = Date.now();
      const TIMEOUT = 5 * 60 * 1000;
      pollRef.current = setInterval(async () => {
        if (Date.now() - startTime > TIMEOUT) {
          cleanupPolling();
          setStage("error");
          setErrorCode("TIMEOUT");
          setErrorMessage("Processing timed out. Please try a shorter video.");
          return;
        }
        try {
          const url = new URL(`/api/progress/${jobId}`, baseUrl);
          const res = await fetch(url.toString());
          const data = await res.json();

          if (data.error && data.stage === "Error") {
            cleanupPolling();
            setStage("error");
            setErrorCode("SERVER");
            setErrorMessage(data.error);
            return;
          }

          // The server reports real progress (0..1) plus a per-frame counter
          // in `detail` — map it into the client's processing window.
          if (data.stage !== "Complete") {
            const label = STAGE_LABELS[data.stage] ?? data.stage ?? "Processing...";
            setStatusText(data.detail ? `${label} (${data.detail})` : label);
            if (typeof data.progress === "number") {
              stopFakeTick();
              advanceProgress(0.34 + Math.min(1, Math.max(0, data.progress)) * 0.63);
            }
          }

          if (data.stage === "Complete" && data.result) {
            stopFakeTick();
            cleanupPolling();
            setStage("complete");
            advanceProgress(1);
            setResult(data.result);
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success
            );
            onStitchSucceeded(data.result);
          }
        } catch {}
      }, 500);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cleanupPolling, advanceProgress, stopFakeTick]
  );

  const processVideoUri = async (uri: string, durationMs: number) => {
    const threshold = SENSITIVITY_PRESETS[sensitivity].value;
    const estimatedFrames = Math.ceil(durationMs / extractionIntervalMs(durationMs));

    progressRef.current = 0;
    startTimeRef.current = Date.now();
    setStage("extracting");
    // Seed the estimate from the frame count so the first figure shown is a
    // considered guess rather than an extrapolation from two seconds of the
    // fastest stage.
    etaPriorRef.current = initialTotalMs(estimatedFrames);
    etaTotalRef.current = etaPriorRef.current;
    etaShownRef.current = null;
    etaLastProgressRef.current = -1;
    setCanLeaveApp(false);
    advanceProgress(0);
    setFrameCount(0);
    setEta(null);
    startEtaTick();
    setCropTop(0);
    setCropBottom(0);
    setStatusText(`Extracting ~${estimatedFrames} frames...`);
    setResult(null);
    setErrorMessage("");
    setErrorCode("");

    const frameUris = await extractFramesFromVideo(
      uri,
      durationMs,
      (current, total) => {
        setFrameCount(current);
        advanceProgress((current / total) * 0.18);
        setStatusText(`Extracting frames: ${current}/${total}`);
      }
    );

    if (frameUris.length === 0) {
      throw new Error("Could not extract any frames from the video");
    }

    setStage("filtering");
    setStatusText(`Filtering ${frameUris.length} frames...`);
    advanceProgress(0.18);

    const filteredUris = await clientDeduplicateFrames(
      frameUris,
      threshold,
      (checked, total) => {
        advanceProgress(0.18 + (checked / total) * 0.08);
        setStatusText(`Filtering: removing duplicates on-device...`);
      }
    );

    const droppedCount = frameUris.length - filteredUris.length;
    console.log(`Client filter: ${frameUris.length} → ${filteredUris.length} frames (dropped ${droppedCount})`);
    return filteredUris;
  };

  /**
   * Upload in batches under one session id, then trigger processing with an
   * empty request.
   *
   * A single multipart body holding every frame is tens of megabytes at 100ms
   * sampling — one dropped connection and the whole recording is lost with
   * nothing to resume from. Batching also gives real progress instead of a
   * simulated tick, since each completed batch is a fact rather than a guess.
   */
  const startUpload = async (filteredUris: string[]) => {
    try {
      setStage("uploading");
      advanceProgress(0.26);

      const baseUrl = getApiUrl();
      const sessionId = `${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      const batches: string[][] = [];
      for (let i = 0; i < filteredUris.length; i += UPLOAD_BATCH_SIZE) {
        batches.push(filteredUris.slice(i, i + UPLOAD_BATCH_SIZE));
      }

      const isWeb = Platform.OS === "web";
      const expoFetch = isWeb ? null : (await import("expo/fetch")).fetch;
      const ExpoFile = isWeb ? null : (await import("expo-file-system")).File;

      for (let b = 0; b < batches.length; b++) {
        setStatusText(`Uploading batch ${b + 1} of ${batches.length}...`);

        const chunkUrl = new URL("/api/upload-chunk", baseUrl);
        chunkUrl.searchParams.set("sessionId", sessionId);
        chunkUrl.searchParams.set("chunkIndex", String(b));

        const formData = new FormData();
        for (let i = 0; i < batches[b].length; i++) {
          if (isWeb) {
            const blob = await (await fetch(batches[b][i])).blob();
            formData.append("frames", blob, `frame_${i.toString().padStart(5, "0")}.jpg`);
          } else {
            formData.append("frames", new ExpoFile!(batches[b][i]) as any);
          }
        }

        const doFetch = isWeb ? fetch : expoFetch!;
        const res = await doFetch(chunkUrl.toString(), { method: "POST", body: formData });
        if (!res.ok) throw new Error(await res.text());

        advanceProgress(0.26 + ((b + 1) / batches.length) * 0.07);
      }

      // Empty request: the server picks the staged frames up by session id.
      const processUrl = new URL("/api/process-frames", baseUrl);
      processUrl.searchParams.set("quality", outputQuality);
      processUrl.searchParams.set("sessionId", sessionId);
      // Registered here rather than at launch: asking to send notifications
      // means something at the moment there is a wait to be told about.
      const pushToken = await getPushToken();
      if (pushToken) {
        processUrl.searchParams.set("pushToken", pushToken);
        setCanLeaveApp(true);
      }

      const doFetch = isWeb ? fetch : expoFetch!;
      const startRes = await doFetch(processUrl.toString(), { method: "POST" });
      if (!startRes.ok) throw new Error(await startRes.text());
      const data = await startRes.json();

      stopFakeTick();
      setStage("processing");
      advanceProgress(0.34);
      setStatusText("Processing frames on server...");
      pollProgress(data.jobId);
    } catch (err: any) {
      stopFakeTick();
      stopEtaTick();
      setStage("error");
      setErrorCode(withDetail("UPLOAD", err));
      setErrorMessage(readableMediaError(err));
    }
  };

  /**
   * Ask PhotoKit for a recording directly, with the iCloud download switched on.
   *
   * The picker has no such option — there is nothing in ImagePickerOptions that
   * says "fetch this from iCloud first" — so a recording that is not on the
   * device can come back as a file the app cannot read. MediaLibrary does have
   * the option, and the picker hands back an assetId that MediaLibrary accepts,
   * which makes this the one way to recover without sending the reader to the
   * Photos app to do it by hand.
   *
   * Returns null whenever that is not possible: no assetId (the picker omits it
   * under limited-library access), no permission, or the fetch itself failing.
   */
  const downloadFromICloud = async (assetId: string | null | undefined): Promise<string | null> => {
    if (!assetId) return null;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") return null;
      setStatusText("Downloading from iCloud...");
      const info = await MediaLibrary.getAssetInfoAsync(assetId, {
        shouldDownloadFromNetwork: true,
      });
      return info.localUri ?? null;
    } catch {
      return null;
    }
  };

  const pickVideo = async () => {
    let pickerResult: ImagePicker.ImagePickerResult;
    let limitedAccess = false;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const permResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permResult.granted) {
        Alert.alert("Permission needed", "Please grant access to your media library.");
        return;
      }
      // granted is true for "Selected Photos" as well as "All Photos", so it
      // cannot be the whole answer. Under limited access the app may only read
      // the recordings the user ticked, and everything else fails at export —
      // which is what a library where some videos work and others do not looks
      // like from in here.
      limitedAccess = permResult.accessPrivileges === "limited";

      // Say it before the picker, not after. The picker shows the whole
      // library whatever the app is allowed to read, so under limited access
      // it happily offers recordings that cannot then be handed over — and
      // finding that out *after* choosing one reads as the app breaking rather
      // than as a setting to change. Once per launch; a warning repeated on
      // every pick becomes noise the reader learns to dismiss.
      if (limitedAccess && !limitedNoticeShownRef.current) {
        limitedNoticeShownRef.current = true;
        const openSettings = await confirmLimitedAccess();
        if (openSettings) {
          Linking.openSettings();
          return;
        }
      }

      pickerResult = await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
    } catch (err: any) {
      // The picker threw while handing the recording over, after it was chosen.
      //
      // Its fast path is the likely reason. With the default passthrough preset
      // expo-image-picker copies the asset's bytes directly, preferring the
      // fullSizeVideo resource — the rendered one, which exists precisely when a
      // recording has been trimmed or edited. Screen recordings get trimmed all
      // the time, which is what a library where some work and others do not
      // looks like from in here.
      //
      // Any preset other than passthrough skips that path and goes the slower,
      // correct way, re-rendering the adjustment properly. Only worth paying for
      // when the quick route has already failed.
      if (limitedAccess) {
        setStage("error");
        setErrorCode(withDetail("PICK-LTD", err));
        setErrorMessage(
          "ScrollStitch only has access to the photos you have selected, and " +
            "this recording is not one of them. In Settings > ScrollStitch > Photos, " +
            "choose All Photos, or add this recording to the selection."
        );
        return;
      }

      const retry = await confirmSlowExport();
      if (!retry) {
        setStage("error");
        setErrorCode(withDetail("PICK", err));
        setErrorMessage(readableMediaError(err));
        return;
      }

      try {
        pickerResult = await ImagePicker.launchImageLibraryAsync({
          ...PICKER_OPTIONS,
          videoExportPreset: ImagePicker.VideoExportPreset.HighestQuality,
        });
      } catch (retryErr: any) {
        setStage("error");
        setErrorCode(withDetail("PICK2", retryErr));
        setErrorMessage(readableMediaError(retryErr));
        return;
      }
    }

    if (pickerResult.canceled || !pickerResult.assets?.[0]) return;
    const asset = pickerResult.assets[0];
    const rawDuration = asset.duration || 10000;
    const durationMs = rawDuration < 1000 ? rawDuration * 1000 : rawDuration;

    const run = async (uri: string) => {
      const filtered = await processVideoUri(uri, durationMs);
      await startUpload(filtered);
    };

    try {
      await run(asset.uri);
      return;
    } catch (err: any) {
      // The picker returned a file that will not open. Before saying so, fetch
      // the asset properly — this is the case the reader was previously asked
      // to fix themselves by opening it in Photos.
      const recovered = await downloadFromICloud(asset.assetId);
      if (!recovered || recovered === asset.uri) {
        setStage("error");
        setErrorCode(withDetail("READ", err));
        setErrorMessage(readableMediaError(err));
        return;
      }
      try {
        await run(recovered);
      } catch (retryErr: any) {
        setStage("error");
        setErrorCode(withDetail("READ2", retryErr));
        setErrorMessage(readableMediaError(retryErr));
      }
    }
  };

  // Web: MediaLibrary/Sharing don't exist in the browser (and RN-web's Alert
  // is a no-op, so their failures were invisible). Download the file instead.
  const webDownloadOutput = async (urlPath: string, filename: string): Promise<void> => {
    const url = new URL(urlPath, getApiUrl()).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to fetch file");
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  };

  const fetchAndSaveFile = async (urlPath: string, filename: string): Promise<string> => {
    const baseUrl = getApiUrl();
    const jobFile = urlPath.split("/").pop();
    const url = new URL(`/api/output-base64/${jobFile}`, baseUrl);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("Failed to fetch file");
    const { base64 } = await res.json();

    const cacheDir = Paths.cache?.uri || LegacyFileSystem.cacheDirectory || "";
    const localUri = cacheDir + (cacheDir.endsWith("/") ? "" : "/") + filename;
    await LegacyFileSystem.writeAsStringAsync(localUri, base64, {
      encoding: LegacyFileSystem.EncodingType.Base64,
    });
    return localUri;
  };

  const saveToPhotos = async () => {
    if (!result || isSaving) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsSaving(true);
    try {
      if (Platform.OS === "web") {
        const ext = result.imageUrl.endsWith(".jpg") ? "jpg" : "png";
        await webDownloadOutput(result.imageUrl, `scrollstitch_${Date.now()}.${ext}`);
        return;
      }
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Please grant access to save images.");
        return;
      }
      // Match the real format — a JPEG saved as .png confuses Photos and any
      // app the user later opens it in.
      const ext = result.imageUrl.endsWith(".jpg") ? "jpg" : "png";
      const localUri = await fetchAndSaveFile(result.imageUrl, `scrollstitch_${Date.now()}.${ext}`);
      await MediaLibrary.saveToLibraryAsync(localUri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved", "Image saved to your photo library.");
    } catch (err: any) {
      console.error("Save error:", err);
      Alert.alert("Error", String(err?.message || err));
    } finally {
      setIsSaving(false);
    }
  };

  const sharePdf = async () => {
    if (!result || isSharing) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsSharing(true);
    try {
      if (Platform.OS === "web") {
        await webDownloadOutput(result.pdfUrl, `scrollstitch_${Date.now()}.pdf`);
        return;
      }
      const localUri = await fetchAndSaveFile(result.pdfUrl, `scrollstitch_${Date.now()}.pdf`);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localUri, {
          mimeType: "application/pdf",
          dialogTitle: "Share ScrollStitch PDF",
        });
      } else {
        Alert.alert("Sharing not available on this device");
      }
    } catch (err: any) {
      console.error("Share error:", err);
      Alert.alert("Error", String(err?.message || err));
    } finally {
      setIsSharing(false);
    }
  };

  const applyCrop = async () => {
    if (!result || isCropping) return;
    if (cropTop === 0 && cropBottom === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsCropping(true);
    try {
      const baseUrl = getApiUrl();
      const filename = result.imageUrl.split("/").pop();
      const url = new URL(`/api/crop/${filename}`, baseUrl);
      url.searchParams.set("top", String(cropTop));
      url.searchParams.set("bottom", String(cropBottom));
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Crop failed");
      const data = await res.json();
      setResult((prev) =>
        prev
          ? {
              ...prev,
              imageUrl: data.imageUrl,
              pdfUrl: data.pdfUrl,
              previewUrl: data.previewUrl ?? data.imageUrl,
              dimensions: data.dimensions ?? prev.dimensions,
            }
          : prev
      );
      setCropTop(0);
      setCropBottom(0);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert("Crop failed", err.message);
    } finally {
      setIsCropping(false);
    }
  };

  const reset = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    cleanupPolling();
    progressRef.current = 0;
    startTimeRef.current = 0;
    setStage("idle");
    setProgress(0);
    setStatusText("");
    setResult(null);
    setErrorMessage("");
    setErrorCode("");
    setFrameCount(0);
    setIsSaving(false);
    setIsSharing(false);
    setEta(null);
    setCropTop(0);
    setCropBottom(0);
  };

  statusTextRef.current = statusText;

  const isProcessing =
    stage === "extracting" || stage === "filtering" || stage === "uploading" || stage === "processing";

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="scan-outline" size={22} color={C.accent} />
          <Text style={styles.headerTitle}>ScrollStitch</Text>
          {isPro && (
            <View style={styles.proBadge}>
              <Text style={styles.proBadgeText}>PRO</Text>
            </View>
          )}
        </View>
        {(stage === "complete" || stage === "error") && (
          <Pressable
            onPress={reset}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel="Start over"
            accessibilityHint="Clears the result and returns to the start screen"
          >
            <Feather name="rotate-ccw" size={20} color={C.textSecondary} />
          </Pressable>
        )}
      </View>

      {/* Upgrade modal for free users */}
      <Modal
        visible={showUpgradeModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowUpgradeModal(false)}
      >
        <View style={styles.upgradeOverlay}>
          <View style={styles.upgradeCard}>
            <View
              style={styles.upgradeIconBg}
            >
              <Feather name="lock" size={24} color={C.accent} />
            </View>
            <Text style={styles.upgradeTitle}>Pro Feature</Text>
            <Text style={styles.upgradeBody}>
              Crop controls, sensitivity settings, and output quality are available in ScrollStitch Pro.
            </Text>
            <Pressable
              onPress={() => {
                setShowUpgradeModal(false);
                // Straight to the paywall — replaying the whole intro (and
                // clearing the onboarding flag) is not what "View Plans" means.
                router.push("/onboarding?directPaywall=1");
              }}
              style={styles.upgradeBtn}
              accessibilityRole="button"
              accessibilityLabel="View plans"
            >
              <View
                style={styles.upgradeBtnGrad}
              >
                <Text style={styles.upgradeBtnText}>View Plans</Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => setShowUpgradeModal(false)}
              style={styles.upgradeDismiss}
              accessibilityRole="button"
              accessibilityLabel="Not now"
            >
              <Text style={styles.upgradeDismissText}>Not now</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Day-3 win-back: switch weekly subscribers to annual */}
      <Modal
        visible={showWinBack}
        transparent
        animationType="fade"
        onRequestClose={dismissWinBack}
      >
        <View style={styles.upgradeOverlay}>
          <View style={styles.upgradeCard}>
            <View
              style={styles.upgradeIconBg}
            >
              <Feather name="trending-down" size={24} color={C.accent} />
            </View>
            <Text style={styles.upgradeTitle}>Pay less for the same thing</Text>
            <Text style={styles.upgradeBody}>
              You&apos;ve been stitching for a few days now. Switch to yearly for{" "}
              {annualPackage?.product.priceString ?? "…"} and stop paying weekly.
            </Text>
            <Pressable
              onPress={acceptWinBack}
              disabled={isPurchasing}
              style={styles.upgradeBtn}
              accessibilityRole="button"
              accessibilityLabel={`Switch to yearly for ${annualPackage?.product.priceString ?? ""}`}
              accessibilityState={{ disabled: isPurchasing, busy: isPurchasing }}
            >
              <View
                style={styles.upgradeBtnGrad}
              >
                {isPurchasing ? (
                  <ActivityIndicator size="small" color="#f3f2f2" />
                ) : (
                  <Text style={styles.upgradeBtnText}>Switch to yearly</Text>
                )}
              </View>
            </Pressable>
            <Pressable
              onPress={dismissWinBack}
              style={styles.upgradeDismiss}
              accessibilityRole="button"
              accessibilityLabel="Keep paying weekly"
            >
              <Text style={styles.upgradeDismissText}>Keep weekly</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + webBottomInset + 20 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {stage === "idle" && (
          <Animated.View entering={FadeIn.duration(400)} style={styles.idleContainer}>
            <View style={styles.heroSection}>
              <View style={styles.iconContainer}>
                <View style={styles.iconGradient}>
                  <Ionicons name="film-outline" size={48} color={C.accent} />
                </View>
              </View>
              <Text style={styles.heroTitle}>Convert Screen Recordings</Text>
              <Text style={styles.heroSubtitle}>
                Pick a screen recording and we&apos;ll extract the unique frames,
                stitch them together, and create a seamless long image or PDF.
              </Text>
            </View>

            <Animated.View style={buttonAnimStyle}>
              <Pressable
                onPress={pickVideo}
                onPressIn={() => { buttonScale.value = withSpring(0.96); }}
                onPressOut={() => { buttonScale.value = withSpring(1); }}
                style={styles.pickButton}
                accessibilityRole="button"
                accessibilityLabel="Pick a screen recording"
                accessibilityHint="Extracts frames and stitches them into one long screenshot"
              >
                <View
                  style={styles.pickButtonGradient}
                >
                  <Feather name="upload" size={22} color="#f3f2f2" />
                  <Text style={styles.pickButtonText}>Pick a Screen Recording</Text>
                </View>
              </Pressable>
            </Animated.View>

            <Pressable
              onPress={() => setShowSettings((v) => !v)}
              style={styles.settingsToggle}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              accessibilityState={{ expanded: showSettings }}
            >
              <Feather name="sliders" size={15} color={C.textSecondary} />
              <Text style={styles.settingsToggleText}>Settings</Text>
              <Feather
                name={showSettings ? "chevron-up" : "chevron-down"}
                size={14}
                color={C.textSecondary}
              />
            </Pressable>

            {showSettings && (
              <View style={styles.settingsPanel}>
                {/* ── Subscription section ── */}
                {customerInfoIsLoading ? (
                  <View style={styles.subscriptionSection}>
                    <Text style={styles.settingLabel}>Subscription</Text>
                    <View style={styles.subErrorRow}>
                      <ActivityIndicator size="small" color={C.textTertiary} />
                      <Text style={styles.subErrorText}>Loading…</Text>
                    </View>
                  </View>
                ) : customerInfoIsError ? (
                  <View style={styles.subscriptionSection}>
                    <Text style={styles.settingLabel}>Subscription</Text>
                    <View style={styles.subErrorRow}>
                      <Feather name="alert-circle" size={14} color={C.danger} />
                      <Text style={styles.subErrorText}>
                        Couldn&apos;t load subscription info
                      </Text>
                      <Pressable
                        onPress={() => refetchCustomerInfo()}
                        style={styles.subErrorRetryBtn}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel="Retry loading subscription info"
                      >
                        <Text style={styles.subErrorRetryText}>Retry</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : isPro ? (
                  <View style={styles.subscriptionSection}>
                    <Text style={styles.settingLabel}>Subscription</Text>
                    <View style={styles.subscriptionInfoRow}>
                      <View style={styles.subscriptionBadge}>
                        <Feather name="zap" size={12} color={C.accent} />
                        <Text style={styles.subscriptionBadgeText}>Pro</Text>
                      </View>
                      <Text style={styles.subscriptionPlanLabel}>
                        {(() => {
                          const productId =
                            customerInfo?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER]
                              ?.productIdentifier ?? "";
                          if (productId.toLowerCase().includes("annual") || productId.toLowerCase().includes("yearly")) {
                            return "Annual plan";
                          }
                          if (productId.toLowerCase().includes("month")) {
                            return "Monthly plan";
                          }
                          return "Active plan";
                        })()}
                      </Text>
                    </View>
                    {customerInfo?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER]?.expirationDate && (
                      <Text style={styles.subscriptionRenewal}>
                        Renews{" "}
                        {formatRenewalDate(
                          customerInfo.entitlements.active[REVENUECAT_ENTITLEMENT_IDENTIFIER]?.expirationDate
                        )}
                      </Text>
                    )}
                    {Platform.OS !== "web" && (
                      <Pressable
                        onPress={openManageSubscriptions}
                        style={styles.manageSubBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Manage subscription"
                        accessibilityHint="Opens your subscription settings in the App Store"
                      >
                        <Feather name="external-link" size={13} color={C.accent} />
                        <Text style={styles.manageSubBtnText}>Manage Subscription</Text>
                      </Pressable>
                    )}
                  </View>
                ) : (
                  <View style={styles.subscriptionSection}>
                    <Text style={styles.settingLabel}>Subscription</Text>
                    <Pressable
                      onPress={() => {
                        setShowSettings(false);
                        router.push("/onboarding?directPaywall=1");
                      }}
                      style={styles.upgradeInlineBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Upgrade to Pro"
                      accessibilityHint="Shows the available subscription plans"
                    >
                      <View
                        style={styles.upgradeInlineBtnGrad}
                      >
                        <Feather name="zap" size={14} color="#f3f2f2" />
                        <Text style={styles.upgradeInlineBtnText}>Upgrade to Pro</Text>
                      </View>
                    </Pressable>
                  </View>
                )}

                {/* ── Restore Purchases ── */}
                <Pressable
                  onPress={async () => {
                    try {
                      await restore();
                      Alert.alert("Restored", "Your purchases have been restored.");
                    } catch {
                      Alert.alert("Restore Failed", "Could not restore purchases. Please try again.");
                    }
                  }}
                  disabled={isRestoring}
                  style={styles.restoreBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Restore purchases"
                  accessibilityState={{ disabled: isRestoring, busy: isRestoring }}
                >
                  {isRestoring ? (
                    <ActivityIndicator size="small" color={C.textTertiary} />
                  ) : (
                    <Feather name="refresh-cw" size={13} color={C.textTertiary} />
                  )}
                  <Text style={styles.restoreBtnText}>
                    {isRestoring ? "Restoring…" : "Restore Purchases"}
                  </Text>
                </Pressable>

                {isPro && (
                  <>
                    <View style={styles.settingsDivider} />
                    <Text style={styles.settingLabel}>Sensitivity</Text>
                <View style={styles.settingRow}>
                  {(Object.keys(SENSITIVITY_PRESETS) as SensitivityKey[]).map((key) => (
                    <Pressable
                      key={key}
                      onPress={() => setSensitivity(key)}
                      style={[
                        styles.chipButton,
                        sensitivity === key && styles.chipButtonActive,
                      ]}
                      accessibilityRole="radio"
                      accessibilityLabel={`Sensitivity: ${SENSITIVITY_PRESETS[key].label}. ${SENSITIVITY_PRESETS[key].desc}`}
                      accessibilityState={{ selected: sensitivity === key }}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          sensitivity === key && styles.chipTextActive,
                        ]}
                      >
                        {SENSITIVITY_PRESETS[key].label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.settingHint}>
                  {SENSITIVITY_PRESETS[sensitivity].desc}
                </Text>

                <Text style={[styles.settingLabel, { marginTop: 16 }]}>Output Quality</Text>
                <View style={styles.settingRow}>
                  {(["png", "jpeg"] as const).map((q) => (
                    <Pressable
                      key={q}
                      onPress={() => setOutputQuality(q)}
                      style={[
                        styles.chipButton,
                        outputQuality === q && styles.chipButtonActive,
                      ]}
                      accessibilityRole="radio"
                      accessibilityLabel={
                        q === "png"
                          ? "Output quality: PNG, lossless, larger file"
                          : "Output quality: JPEG, smaller file, slight compression"
                      }
                      accessibilityState={{ selected: outputQuality === q }}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          outputQuality === q && styles.chipTextActive,
                        ]}
                      >
                        {q.toUpperCase()}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.settingHint}>
                  {outputQuality === "png" ? "Lossless, larger file" : "Smaller file, slight compression"}
                </Text>


                  </>
                )}
              </View>
            )}
          </Animated.View>
        )}

        {isProcessing && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.processingContainer}>
            <View style={styles.processingCard}>
              <View style={styles.processingHeader}>
                <PulsingDot />
                <Text style={styles.processingTitle}>Processing</Text>
              </View>

              <ProgressBar progress={progress} />

              <Text style={styles.progressPercent}>
                {Math.round(progress * 100)}%
              </Text>
              <Text style={styles.statusText}>{statusText}</Text>
              {eta && (
                <Text style={styles.etaText}>{eta}</Text>
              )}
              {canLeaveApp && (
                <View style={styles.leaveHint}>
                  <Feather name="bell" size={13} color={C.textTertiary} />
                  <Text style={styles.leaveHintText}>
                    You can leave the app — we&apos;ll notify you when it&apos;s done.
                  </Text>
                </View>
              )}

              <View style={styles.stageIndicators}>
                {[
                  { key: "extracting", label: "Extract" },
                  { key: "filtering", label: "Filter" },
                  { key: "uploading", label: "Upload" },
                  { key: "processing", label: "Process" },
                ].map((s) => {
                  const stageOrder = ["extracting", "filtering", "uploading", "processing"];
                  const isActive = stage === s.key;
                  const isPast =
                    stageOrder.indexOf(stage) > stageOrder.indexOf(s.key);
                  return (
                    <View
                      key={s.key}
                      style={[
                        styles.stageChip,
                        isActive && styles.stageChipActive,
                        isPast && styles.stageChipDone,
                      ]}
                    >
                      {isPast && (
                        <Feather name="check" size={12} color={C.accent} />
                      )}
                      <Text
                        style={[
                          styles.stageChipText,
                          isActive && styles.stageChipTextActive,
                          isPast && styles.stageChipTextDone,
                        ]}
                      >
                        {s.label}
                      </Text>
                    </View>
                  );
                })}
              </View>

              {stage === "extracting" && frameCount > 0 && (
                <Text style={styles.frameCountText}>
                  {frameCount} frames extracted
                </Text>
              )}
            </View>
          </Animated.View>
        )}

        {stage === "error" && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.errorContainer}>
            <View
              style={styles.errorCard}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              <Feather name="alert-circle" size={40} color={C.danger} />
              <Text style={styles.errorTitle}>Processing Failed</Text>
              <Text style={styles.errorMessage}>{errorMessage}</Text>
              {errorCode ? (
                <Text style={styles.errorCode}>{`Error code: ${errorCode}`}</Text>
              ) : null}
              <Pressable
                onPress={reset}
                style={styles.retryButton}
                accessibilityRole="button"
                accessibilityLabel="Try again"
              >
                <Feather name="rotate-ccw" size={18} color={C.accent} />
                <Text style={styles.retryText}>Try Again</Text>
              </Pressable>
            </View>
          </Animated.View>
        )}

        {stage === "complete" && result && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.resultContainer}>
            <View style={styles.statsRow}>
              <View
                style={styles.statCard}
                accessible
                accessibilityLabel={`${result.frameCount} frames captured in total`}
              >
                <Text style={styles.statValue}>{result.frameCount}</Text>
                <Text style={styles.statLabel}>Total Frames</Text>
              </View>
              <View
                style={styles.statCard}
                accessible
                accessibilityLabel={`${result.selectedFrames ?? result.uniqueFrames} frames used in the stitch`}
              >
                <Text style={styles.statValue}>
                  {result.selectedFrames ?? result.uniqueFrames}
                </Text>
                <Text style={styles.statLabel}>Stitched</Text>
              </View>
              <View
                style={styles.statCard}
                accessible
                accessibilityLabel={`Result size: ${result.dimensions.width} by ${result.dimensions.height} pixels`}
              >
                <Text style={styles.statValue}>
                  {result.dimensions.width}x{result.dimensions.height}
                </Text>
                <Text style={styles.statLabel}>Size</Text>
              </View>
            </View>

            {((result.gapCount ?? 0) > 0 || (result.warnings?.length ?? 0) > 0) && (
              <View
                style={styles.warningCard}
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                <View style={styles.warningTitleRow}>
                  <Feather name="alert-triangle" size={16} color={C.warning} />
                  <Text style={styles.warningTitle}>
                    {(result.gapCount ?? 0) > 0
                      ? `${result.gapCount} scroll jump${(result.gapCount ?? 0) > 1 ? "s" : ""} detected`
                      : "Heads up"}
                  </Text>
                </View>
                {(result.warnings ?? []).slice(0, 3).map((w, idx) => (
                  <Text key={idx} style={styles.warningText}>
                    {w}
                  </Text>
                ))}
                {(result.warnings?.length ?? 0) > 3 && (
                  <Text style={styles.warningText}>
                    +{(result.warnings?.length ?? 0) - 3} more warning(s)
                  </Text>
                )}
              </View>
            )}

            <View style={styles.previewContainer}>
              <View style={styles.previewLabelRow}>
                <Text style={styles.previewLabel}>Preview</Text>
                <Text style={styles.previewHint}>Pinch to zoom</Text>
              </View>
              <ScrollView
                style={styles.previewScroll}
                contentContainerStyle={styles.previewContent}
                showsVerticalScrollIndicator={true}
                showsHorizontalScrollIndicator={false}
                nestedScrollEnabled={true}
                maximumZoomScale={Platform.OS === "ios" ? 6 : 1}
                minimumZoomScale={1}
                bouncesZoom={true}
              >
                <Image
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel={`Stitched screenshot, ${result.dimensions.width} by ${result.dimensions.height} pixels`}
                  source={{
                    uri: new URL(result.previewUrl ?? result.imageUrl, getApiUrl()).toString(),
                  }}
                  style={{
                    width: SCREEN_WIDTH - 64,
                    height:
                      ((SCREEN_WIDTH - 64) / result.dimensions.width) *
                      result.dimensions.height,
                  }}
                  contentFit="contain"
                  transition={300}
                />
              </ScrollView>
            </View>

            {isPro ? (
              <View style={styles.cropPanel}>
                <View style={styles.cropTitleRow}>
                  <Feather name="crop" size={14} color={C.textSecondary} />
                  <Text style={styles.cropTitle}>Trim edges</Text>
                </View>
                <View style={styles.cropRow}>
                  <View style={styles.cropControl}>
                    <Text style={styles.cropControlLabel}>Top  {cropTop > 0 ? `${cropTop}px` : ""}</Text>
                    <View style={styles.cropStepper}>
                      <Pressable
                        onPress={() => setCropTop((v) => Math.max(0, v - 50))}
                        style={styles.stepperBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Decrease top trim by 50 pixels"
                        accessibilityValue={{ text: `${cropTop} pixels` }}
                        accessibilityState={{ disabled: cropTop === 0 }}
                      >
                        <Feather name="minus" size={16} color={C.textSecondary} />
                      </Pressable>
                      <Text style={styles.stepperVal}>{cropTop}</Text>
                      <Pressable
                        onPress={() => setCropTop((v) => Math.min(result.dimensions.height / 2 - 10, v + 50))}
                        style={styles.stepperBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Increase top trim by 50 pixels"
                        accessibilityValue={{ text: `${cropTop} pixels` }}
                      >
                        <Feather name="plus" size={16} color={C.accent} />
                      </Pressable>
                    </View>
                  </View>
                  <View style={styles.cropControl}>
                    <Text style={styles.cropControlLabel}>Bottom  {cropBottom > 0 ? `${cropBottom}px` : ""}</Text>
                    <View style={styles.cropStepper}>
                      <Pressable
                        onPress={() => setCropBottom((v) => Math.max(0, v - 50))}
                        style={styles.stepperBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Decrease bottom trim by 50 pixels"
                        accessibilityValue={{ text: `${cropBottom} pixels` }}
                        accessibilityState={{ disabled: cropBottom === 0 }}
                      >
                        <Feather name="minus" size={16} color={C.textSecondary} />
                      </Pressable>
                      <Text style={styles.stepperVal}>{cropBottom}</Text>
                      <Pressable
                        onPress={() => setCropBottom((v) => Math.min(result.dimensions.height / 2 - 10, v + 50))}
                        style={styles.stepperBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Increase bottom trim by 50 pixels"
                        accessibilityValue={{ text: `${cropBottom} pixels` }}
                      >
                        <Feather name="plus" size={16} color={C.accent} />
                      </Pressable>
                    </View>
                  </View>
                </View>
                {(cropTop > 0 || cropBottom > 0) && (
                  <Pressable
                    onPress={applyCrop}
                    disabled={isCropping}
                    style={styles.cropApplyBtn}
                    accessibilityRole="button"
                    accessibilityLabel={isCropping ? "Cropping" : "Apply crop"}
                    accessibilityState={{ disabled: isCropping, busy: isCropping }}
                  >
                    {isCropping ? (
                      <ActivityIndicator size="small" color="#f3f2f2" />
                    ) : (
                      <Feather name="check" size={16} color="#f3f2f2" />
                    )}
                    <Text style={styles.cropApplyText}>
                      {isCropping ? "Cropping..." : "Apply Crop"}
                    </Text>
                  </Pressable>
                )}
              </View>
            ) : (
              <Pressable
                onPress={() => setShowUpgradeModal(true)}
                style={styles.cropPanelLocked}
                accessibilityRole="button"
                accessibilityLabel="Trim edges, a Pro feature"
                accessibilityHint="Shows the available subscription plans"
              >
                <Feather name="lock" size={14} color={C.accent} />
                <Text style={styles.cropPanelLockedText}>Trim edges — Pro feature</Text>
                <View style={styles.proLockBadge}>
                  <Text style={styles.proLockText}>UPGRADE</Text>
                </View>
              </Pressable>
            )}

            {(isSaving || isSharing) && (
              <ActivityOverlay label={isSaving ? "Preparing image..." : "Preparing PDF..."} />
            )}

            <View style={styles.actionButtons}>
              <Pressable
                onPress={saveToPhotos}
                disabled={isSaving || isSharing || isCropping}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.saveButton,
                  pressed && styles.actionButtonPressed,
                  (isSaving || isSharing || isCropping) && styles.actionButtonDisabled,
                ]}
                accessibilityRole="button"
                accessibilityLabel={isSaving ? "Saving image" : "Save to Photos"}
                accessibilityState={{
                  disabled: isSaving || isSharing || isCropping,
                  busy: isSaving,
                }}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color="#f3f2f2" />
                ) : (
                  <Feather name="download" size={20} color="#f3f2f2" />
                )}
                <Text style={styles.saveButtonText}>
                  {isSaving ? "Saving..." : "Save to Photos"}
                </Text>
              </Pressable>

              <Pressable
                onPress={sharePdf}
                disabled={isSaving || isSharing || isCropping}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.shareButton,
                  pressed && styles.actionButtonPressed,
                  (isSaving || isSharing || isCropping) && styles.actionButtonDisabled,
                ]}
                accessibilityRole="button"
                accessibilityLabel={isSharing ? "Preparing PDF" : "Share as PDF"}
                accessibilityState={{
                  disabled: isSaving || isSharing || isCropping,
                  busy: isSharing,
                }}
              >
                {isSharing ? (
                  <ActivityIndicator size="small" color={C.accent} />
                ) : (
                  <Feather name="share" size={20} color={C.accent} />
                )}
                <Text style={styles.shareButtonText}>
                  {isSharing ? "Preparing..." : "Share as PDF"}
                </Text>
              </Pressable>
            </View>

            <Pressable
              onPress={reset}
              style={styles.newVideoButton}
              accessibilityRole="button"
              accessibilityLabel="Process another video"
            >
              <Feather name="plus" size={18} color={C.textSecondary} />
              <Text style={styles.newVideoText}>Process Another Video</Text>
            </Pressable>
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: C.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Archivo_800ExtraBold",
    color: C.text,
    letterSpacing: -0.01,
    textTransform: "uppercase",
  },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 0,
  },
  replayIntroBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 20,
    alignSelf: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  replayIntroText: {
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
  },
  proBadge: {
    backgroundColor: C.accent,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 0,
  },
  proBadgeText: {
    fontSize: 9,
    fontFamily: "Archivo_800ExtraBold",
    color: "#f3f2f2",
    letterSpacing: 1,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  idleContainer: {
    flex: 1,
    paddingTop: 20,
  },
  heroSection: {
    alignItems: "center",
    marginBottom: 36,
  },
  iconContainer: {
    marginBottom: 24,
  },
  iconGradient: {
    backgroundColor: C.accentMuted,
    width: 96,
    height: 96,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: {
    fontSize: 26,
    fontFamily: "Archivo_800ExtraBold",
    color: C.text,
    textAlign: "center",
    marginBottom: 12,
  },
  heroSubtitle: {
    fontSize: 15,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    paddingHorizontal: 10,
  },
  pickButton: {
    borderRadius: 0,
    overflow: "hidden",
    marginBottom: 12,
  },
  pickButtonGradient: {
    backgroundColor: C.accent,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 18,
    gap: 10,
  },
  pickButtonText: {
    fontSize: 15,
    fontFamily: "Archivo_800ExtraBold",
    color: C.onAccent,
    letterSpacing: 0.02,
    textTransform: "uppercase",
  },
  stepsContainer: {
    backgroundColor: C.surface,
    borderRadius: 0,
    padding: 20,
    gap: 16,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  stepIcon: {
    width: 36,
    height: 36,
    borderRadius: 0,
    backgroundColor: C.accentMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLabel: {
    fontSize: 15,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  processingContainer: {
    paddingTop: 40,
  },
  processingCard: {
    backgroundColor: C.surface,
    borderRadius: 0,
    padding: 28,
    alignItems: "center",
  },
  processingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 24,
  },
  pulsingDot: {
    width: 10,
    height: 10,
    borderRadius: 0,
    backgroundColor: C.accent,
  },
  processingTitle: {
    fontSize: 18,
    fontFamily: "Archivo_600SemiBold",
    color: C.text,
  },
  progressBarContainer: {
    width: "100%",
    height: 8,
    backgroundColor: C.neutral200,
    borderRadius: 0,
    overflow: "hidden",
    marginBottom: 20,
  },
  progressBarFill: {
    backgroundColor: C.accent,
    height: "100%",
    borderRadius: 0,
    overflow: "hidden",
  },
  progressPercent: {
    fontSize: 56,
    fontFamily: "Archivo_800ExtraBold",
    color: C.accent,
    lineHeight: 58,
    marginBottom: 20,
  },
  statusText: {
    fontSize: 11,
    fontFamily: "Archivo_800ExtraBold",
    color: C.neutral700,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    marginBottom: 20,
    textAlign: "center",
  },
  stageIndicators: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  stageChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 0,
    backgroundColor: C.surfaceElevated,
  },
  stageChipActive: {
    backgroundColor: C.accentMuted,
    borderWidth: 1,
    borderColor: C.accentDim,
  },
  stageChipDone: {
    backgroundColor: "rgba(236,48,19,0.08)",
  },
  stageChipText: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
  },
  stageChipTextActive: {
    color: C.accent,
  },
  stageChipTextDone: {
    color: C.accentDim,
  },
  frameCountText: {
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.accentDim,
    marginTop: 16,
  },
  errorContainer: {
    paddingTop: 40,
  },
  errorCard: {
    backgroundColor: C.surface,
    borderRadius: 0,
    padding: 32,
    alignItems: "center",
    gap: 12,
  },
  errorTitle: {
    fontSize: 20,
    fontFamily: "Archivo_600SemiBold",
    color: C.text,
  },
  errorMessage: {
    fontSize: 14,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 20,
  },
  errorCode: {
    fontSize: 11,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
    textAlign: "center",
    marginTop: 6,
    letterSpacing: 0.5,
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 0,
    backgroundColor: C.accentMuted,
    marginTop: 8,
  },
  retryText: {
    fontSize: 15,
    fontFamily: "Archivo_600SemiBold",
    color: C.accent,
  },
  resultContainer: {
    paddingTop: 16,
  },
  statsRow: {
    flexDirection: "row",
    marginBottom: 20,
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderColor: C.border,
  },
  statCard: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: "center",
    borderRightWidth: 1,
    borderRightColor: C.border,
  },
  statValue: {
    fontSize: 20,
    fontFamily: "Archivo_800ExtraBold",
    color: C.text,
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 10,
    fontFamily: "Archivo_400Regular",
    color: C.neutral600,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  warningCard: {
    backgroundColor: "rgba(201,75,57,0.08)",
    borderWidth: 1,
    borderColor: "rgba(201,75,57,0.40)",
    borderRadius: 0,
    padding: 14,
    marginBottom: 20,
    gap: 8,
  },
  warningTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  warningTitle: {
    fontSize: 14,
    fontFamily: "Archivo_600SemiBold",
    color: C.warning,
  },
  warningText: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
    lineHeight: 17,
  },
  previewContainer: {
    backgroundColor: C.surface,
    borderRadius: 0,
    overflow: "hidden",
    marginBottom: 20,
  },
  previewLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  previewLabel: {
    fontSize: 13,
    fontFamily: "Archivo_600SemiBold",
    color: C.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  previewHint: {
    fontSize: 11,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
  },
  previewScroll: {
    maxHeight: 400,
  },
  previewContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  actionButtons: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  actionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 0,
  },
  actionButtonPressed: {
    opacity: 0.8,
  },
  actionButtonDisabled: {
    opacity: 0.6,
  },
  activityOverlay: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: C.surface,
    borderRadius: 0,
    marginBottom: 12,
  },
  activityText: {
    fontSize: 14,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  saveButton: {
    backgroundColor: C.accent,
  },
  saveButtonText: {
    fontSize: 15,
    fontFamily: "Archivo_600SemiBold",
    color: "#f3f2f2",
  },
  shareButton: {
    backgroundColor: C.accentMuted,
    borderWidth: 1,
    borderColor: "rgba(236,48,19,0.3)",
  },
  shareButtonText: {
    fontSize: 15,
    fontFamily: "Archivo_600SemiBold",
    color: C.accent,
  },
  newVideoButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 0,
    backgroundColor: C.surface,
    marginBottom: 20,
  },
  newVideoText: {
    fontSize: 14,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  settingsToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    marginBottom: 4,
  },
  settingsToggleText: {
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  settingsPanel: {
    backgroundColor: C.surface,
    borderRadius: 0,
    padding: 16,
    marginBottom: 20,
    gap: 8,
  },
  settingLabel: {
    fontSize: 12,
    fontFamily: "Archivo_600SemiBold",
    color: C.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  settingRow: {
    flexDirection: "row",
    gap: 8,
  },
  settingHint: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
    opacity: 0.7,
    marginTop: 2,
  },
  chipButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 0,
    backgroundColor: C.background,
    borderWidth: 1,
    borderColor: "rgba(32,30,29,0.08)",
    alignItems: "center",
  },
  chipButtonActive: {
    backgroundColor: "rgba(236,48,19,0.15)",
    borderColor: C.accent,
  },
  chipText: {
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  chipTextActive: {
    color: C.accent,
  },
  etaText: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    marginTop: 2,
    opacity: 0.8,
  },
  leaveHint: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 12,
  },
  leaveHintText: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
    textAlign: "center",
    flexShrink: 1,
  },
  cropPanel: {
    backgroundColor: C.surface,
    borderRadius: 0,
    padding: 16,
    marginBottom: 16,
    gap: 12,
  },
  cropTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cropTitle: {
    fontSize: 13,
    fontFamily: "Archivo_600SemiBold",
    color: C.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cropRow: {
    flexDirection: "row",
    gap: 12,
  },
  cropControl: {
    flex: 1,
    gap: 6,
  },
  cropControlLabel: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  cropStepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.background,
    borderRadius: 0,
    overflow: "hidden",
  },
  stepperBtn: {
    padding: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperVal: {
    flex: 1,
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Archivo_600SemiBold",
    color: C.text,
  },
  cropApplyBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 0,
    backgroundColor: C.accent,
  },
  cropApplyText: {
    fontSize: 14,
    fontFamily: "Archivo_600SemiBold",
    color: "#f3f2f2",
  },
  cropPanelLocked: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.surface,
    borderRadius: 0,
    padding: 16,
    marginBottom: 16,
  },
  cropPanelLockedText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  proLockBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "rgba(236,48,19,0.12)",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 0,
  },
  proLockText: {
    fontSize: 9,
    fontFamily: "Archivo_800ExtraBold",
    color: C.accent,
    letterSpacing: 0.5,
  },
  upgradeOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  upgradeCard: {
    backgroundColor: "#eae9e9",
    borderRadius: 0,
    padding: 28,
    width: "100%",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(32,30,29,0.08)",
  },
  upgradeIconBg: {
    backgroundColor: C.accentMuted,
    width: 64,
    height: 64,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  upgradeTitle: {
    fontSize: 22,
    fontFamily: "Archivo_800ExtraBold",
    color: C.text,
    marginBottom: 10,
  },
  upgradeBody: {
    fontSize: 14,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  upgradeBtn: {
    width: "100%",
    borderRadius: 0,
    overflow: "hidden",
    marginBottom: 12,
  },
  upgradeBtnGrad: {
    backgroundColor: C.accent,
    paddingVertical: 16,
    alignItems: "center",
  },
  upgradeBtnText: {
    fontSize: 16,
    fontFamily: "Archivo_800ExtraBold",
    color: "#f3f2f2",
  },
  upgradeDismiss: {
    paddingVertical: 8,
  },
  upgradeDismissText: {
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
  },
  // Subscription section
  subscriptionSection: {
    gap: 8,
    marginBottom: 4,
  },
  subscriptionInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  subscriptionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(236,48,19,0.12)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 0,
  },
  subscriptionBadgeText: {
    fontSize: 12,
    fontFamily: "Archivo_800ExtraBold",
    color: C.accent,
  },
  subscriptionPlanLabel: {
    fontSize: 14,
    fontFamily: "Archivo_400Regular",
    color: C.text,
  },
  subscriptionRenewal: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  manageSubBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 0,
    backgroundColor: "rgba(236,48,19,0.1)",
    borderWidth: 1,
    borderColor: "rgba(236,48,19,0.25)",
  },
  manageSubBtnText: {
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.accent,
  },
  upgradeInlineBtn: {
    borderRadius: 0,
    overflow: "hidden",
  },
  upgradeInlineBtnGrad: {
    backgroundColor: C.accent,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
  },
  upgradeInlineBtnText: {
    fontSize: 14,
    fontFamily: "Archivo_800ExtraBold",
    color: "#f3f2f2",
  },
  restoreBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  restoreBtnText: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
  },
  settingsDivider: {
    height: 1,
    backgroundColor: "rgba(32,30,29,0.06)",
    marginVertical: 4,
  },
  subErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(174,24,0,0.10)",
    borderWidth: 1,
    borderColor: "rgba(174,24,0,0.25)",
    borderRadius: 0,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  subErrorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: "rgba(32,30,29,0.75)",
  },
  subErrorRetryBtn: {
    backgroundColor: "rgba(236,48,19,0.15)",
    borderRadius: 0,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  subErrorRetryText: {
    color: C.accent,
    fontSize: 13,
    fontFamily: "Archivo_600SemiBold",
  },
});
