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
import { LinearGradient } from "expo-linear-gradient";
import { getApiUrl } from "@/lib/query-client";
import { useSubscription, REVENUECAT_ENTITLEMENT_IDENTIFIER } from "@/lib/revenuecat";
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
      <Animated.View style={[styles.progressBarFill, barStyle]}>
        <LinearGradient
          colors={[C.accent, "#00E5B8"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
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

  for (let i = 0; i < totalFrames; i++) {
    const time = i * intervalMs;
    try {
      const thumb = await VideoThumbnails.getThumbnailAsync(uri, {
        time,
        quality: 0.7,
      });
      frameUris.push(thumb.uri);
    } catch {}
    onProgress(i + 1, totalFrames);
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

function formatEta(ms: number): string {
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `~${sec}s remaining`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `~${min}m ${rem}s remaining`;
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

export default function ScrollSnapScreen() {
  const insets = useSafeAreaInsets();
  const { isPro, resetOnboarding } = useAppContext();
  const { customerInfo, restore, isRestoring, customerInfoIsError, refetchCustomerInfo } = useSubscription();
  const router = useRouter();
  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [frameCount, setFrameCount] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [sensitivity, setSensitivity] = useState<SensitivityKey>("balanced");
  const [outputQuality, setOutputQuality] = useState<"png" | "jpeg">("png");
  const [eta, setEta] = useState<string | null>(null);
  const [cropTop, setCropTop] = useState(0);
  const [cropBottom, setCropBottom] = useState(0);
  const [isCropping, setIsCropping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fakeTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef(0);
  const statusTextRef = useRef("");
  const startTimeRef = useRef(0);
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
    if (next > 0.05 && next < 0.98 && startTimeRef.current > 0) {
      const elapsed = Date.now() - startTimeRef.current;
      const totalEst = elapsed / next;
      const remaining = totalEst - elapsed;
      if (remaining > 2000) setEta(formatEta(remaining));
      else setEta(null);
    }
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
  }, [stopFakeTick]);

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

  const pollProgress = useCallback(
    (jobId: string) => {
      const baseUrl = getApiUrl();
      const startTime = Date.now();
      const TIMEOUT = 5 * 60 * 1000;
      pollRef.current = setInterval(async () => {
        if (Date.now() - startTime > TIMEOUT) {
          cleanupPolling();
          setStage("error");
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
          }
        } catch {}
      }, 500);
    },
    [cleanupPolling, advanceProgress, stopFakeTick]
  );

  const processVideoUri = async (uri: string, durationMs: number) => {
    const threshold = SENSITIVITY_PRESETS[sensitivity].value;
    const estimatedFrames = Math.ceil(durationMs / extractionIntervalMs(durationMs));

    progressRef.current = 0;
    startTimeRef.current = Date.now();
    setStage("extracting");
    advanceProgress(0);
    setFrameCount(0);
    setEta(null);
    setCropTop(0);
    setCropBottom(0);
    setStatusText(`Extracting ~${estimatedFrames} frames...`);
    setResult(null);
    setErrorMessage("");

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

  const startUpload = async (filteredUris: string[]) => {
    try {
      setStage("uploading");
      setStatusText(`Uploading ${filteredUris.length} frames...`);
      advanceProgress(0.26);

      const estimatedUploadMs = Math.max(2000, filteredUris.length * 60);
      startFakeTick(0.18, 0.32, estimatedUploadMs);

      const baseUrl = getApiUrl();
      const uploadUrl = new URL("/api/process-frames", baseUrl);
      uploadUrl.searchParams.set("quality", outputQuality);

      if (Platform.OS === "web") {
        const formData = new FormData();
        for (let i = 0; i < filteredUris.length; i++) {
          const response = await fetch(filteredUris[i]);
          const blob = await response.blob();
          formData.append("frames", blob, `frame_${i.toString().padStart(5, "0")}.jpg`);
        }
        const uploadRes = await fetch(uploadUrl.toString(), {
          method: "POST",
          body: formData,
        });
        if (!uploadRes.ok) throw new Error(await uploadRes.text());
        const data = await uploadRes.json();

        stopFakeTick();
        setStage("processing");
        advanceProgress(0.33);
        setStatusText("Processing frames on server...");
        pollProgress(data.jobId);
      } else {
        const { fetch: expoFetch } = await import("expo/fetch");
        const { File: ExpoFile } = await import("expo-file-system");
        const formData = new FormData();

        for (let i = 0; i < filteredUris.length; i++) {
          const file = new ExpoFile(filteredUris[i]);
          formData.append("frames", file as any);
        }

        const uploadRes = await expoFetch(uploadUrl.toString(), {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) throw new Error(await uploadRes.text());
        const data = await uploadRes.json();

        stopFakeTick();
        setStage("processing");
        advanceProgress(0.33);
        setStatusText("Processing frames on server...");
        pollProgress(data.jobId);
      }
    } catch (err: any) {
      setStage("error");
      setErrorMessage(err.message || "Failed to process video");
    }
  };

  const pickVideo = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const permResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permResult.granted) {
        Alert.alert("Permission needed", "Please grant access to your media library.");
        return;
      }
      const pickerResult = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["videos"],
        quality: 1,
        videoMaxDuration: 300,
      });
      if (pickerResult.canceled || !pickerResult.assets?.[0]) return;
      const asset = pickerResult.assets[0];
      const rawDuration = asset.duration || 10000;
      const durationMs = rawDuration < 1000 ? rawDuration * 1000 : rawDuration;
      const filtered = await processVideoUri(asset.uri, durationMs);
      await startUpload(filtered);
    } catch (err: any) {
      setStage("error");
      setErrorMessage(err.message || "Failed to process video");
    }
  };

  const pickLatestVideo = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Please grant access to your media library.");
        return;
      }
      const { assets } = await MediaLibrary.getAssetsAsync({
        mediaType: MediaLibrary.MediaType.video,
        sortBy: [MediaLibrary.SortBy.creationTime],
        first: 1,
      });
      if (!assets.length) {
        Alert.alert("No videos found", "No screen recordings found in your library.");
        return;
      }
      const asset = assets[0];
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      const uri = info.localUri || asset.uri;
      const durationMs = (asset.duration || 10) * 1000;
      const filtered = await processVideoUri(uri, durationMs);
      await startUpload(filtered);
    } catch (err: any) {
      setStage("error");
      setErrorMessage(err.message || "Failed to process video");
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
        await webDownloadOutput(result.imageUrl, `scrollsnap_${Date.now()}.${ext}`);
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
      const localUri = await fetchAndSaveFile(result.imageUrl, `scrollsnap_${Date.now()}.${ext}`);
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
        await webDownloadOutput(result.pdfUrl, `scrollsnap_${Date.now()}.pdf`);
        return;
      }
      const localUri = await fetchAndSaveFile(result.pdfUrl, `scrollsnap_${Date.now()}.pdf`);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localUri, {
          mimeType: "application/pdf",
          dialogTitle: "Share ScrollSnap PDF",
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
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="scan-outline" size={22} color={C.accent} />
          <Text style={styles.headerTitle}>ScrollSnap</Text>
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
            <LinearGradient
              colors={["rgba(0,212,170,0.2)", "rgba(0,212,170,0.04)"]}
              style={styles.upgradeIconBg}
            >
              <Feather name="lock" size={24} color={C.accent} />
            </LinearGradient>
            <Text style={styles.upgradeTitle}>Pro Feature</Text>
            <Text style={styles.upgradeBody}>
              Crop controls, sensitivity settings, and output quality are available in ScrollSnap Pro.
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
              <LinearGradient
                colors={[C.accent, "#00E5B8"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.upgradeBtnGrad}
              >
                <Text style={styles.upgradeBtnText}>View Plans</Text>
              </LinearGradient>
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
                <LinearGradient
                  colors={["rgba(0, 212, 170, 0.2)", "rgba(0, 212, 170, 0.05)"]}
                  style={styles.iconGradient}
                >
                  <Ionicons name="film-outline" size={48} color={C.accent} />
                </LinearGradient>
              </View>
              <Text style={styles.heroTitle}>Convert Screen Recordings</Text>
              <Text style={styles.heroSubtitle}>
                Pick a screen recording and we&apos;ll extract the unique frames,
                stitch them together, and create a seamless long image or PDF.
              </Text>
            </View>

            <Animated.View style={buttonAnimStyle}>
              <Pressable
                onPress={Platform.OS === "web" ? pickVideo : pickLatestVideo}
                onPressIn={() => { buttonScale.value = withSpring(0.96); }}
                onPressOut={() => { buttonScale.value = withSpring(1); }}
                style={styles.pickButton}
                accessibilityRole="button"
                accessibilityLabel={
                  Platform.OS === "web" ? "Pick a screen recording" : "Use latest recording"
                }
                accessibilityHint="Extracts frames and stitches them into one long screenshot"
              >
                <LinearGradient
                  colors={[C.accent, "#00E5B8"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.pickButtonGradient}
                >
                  <Feather name={Platform.OS === "web" ? "upload" : "zap"} size={22} color="#0A0E17" />
                  <Text style={styles.pickButtonText}>
                    {Platform.OS === "web" ? "Pick a Screen Recording" : "Use Latest Recording"}
                  </Text>
                </LinearGradient>
              </Pressable>
            </Animated.View>

            {Platform.OS !== "web" && (
              <Pressable
                onPress={pickVideo}
                style={styles.secondaryButton}
                accessibilityRole="button"
                accessibilityLabel="Pick from library"
              >
                <Feather name="folder" size={18} color={C.accent} />
                <Text style={styles.secondaryButtonText}>Pick from Library</Text>
              </Pressable>
            )}

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
                {customerInfoIsError ? (
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
                      <LinearGradient
                        colors={[C.accent, "#00E5B8"]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.upgradeInlineBtnGrad}
                      >
                        <Feather name="zap" size={14} color="#0A0E17" />
                        <Text style={styles.upgradeInlineBtnText}>Upgrade to Pro</Text>
                      </LinearGradient>
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

                <Pressable
                  onPress={async () => {
                    await resetOnboarding();
                    router.replace("/onboarding");
                  }}
                  style={styles.replayIntroBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Replay intro"
                  accessibilityHint="Shows the introduction screens again"
                >
                  <Feather name="play-circle" size={14} color={C.textTertiary} />
                  <Text style={styles.replayIntroText}>Replay intro</Text>
                </Pressable>
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
                      <ActivityIndicator size="small" color="#0A0E17" />
                    ) : (
                      <Feather name="check" size={16} color="#0A0E17" />
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
                  <ActivityIndicator size="small" color="#0A0E17" />
                ) : (
                  <Feather name="download" size={20} color="#0A0E17" />
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
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
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
    fontFamily: "Inter_400Regular",
    color: C.textTertiary,
  },
  proBadge: {
    backgroundColor: C.accent,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  proBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#0A0E17",
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
    width: 96,
    height: 96,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: C.text,
    textAlign: "center",
    marginBottom: 12,
  },
  heroSubtitle: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    paddingHorizontal: 10,
  },
  pickButton: {
    borderRadius: 16,
    overflow: "hidden",
    marginBottom: 12,
  },
  pickButtonGradient: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 18,
    gap: 10,
  },
  pickButtonText: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#0A0E17",
  },
  stepsContainer: {
    backgroundColor: C.surface,
    borderRadius: 16,
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
    borderRadius: 12,
    backgroundColor: C.accentMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLabel: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  processingContainer: {
    paddingTop: 40,
  },
  processingCard: {
    backgroundColor: C.surface,
    borderRadius: 20,
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
    borderRadius: 5,
    backgroundColor: C.accent,
  },
  processingTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  progressBarContainer: {
    width: "100%",
    height: 6,
    backgroundColor: C.surfaceElevated,
    borderRadius: 3,
    overflow: "hidden",
    marginBottom: 16,
  },
  progressBarFill: {
    height: "100%",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressPercent: {
    fontSize: 36,
    fontFamily: "Inter_700Bold",
    color: C.accent,
    marginBottom: 8,
  },
  statusText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    marginBottom: 24,
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
    borderRadius: 20,
    backgroundColor: C.surfaceElevated,
  },
  stageChipActive: {
    backgroundColor: C.accentMuted,
    borderWidth: 1,
    borderColor: C.accentDim,
  },
  stageChipDone: {
    backgroundColor: "rgba(0, 212, 170, 0.08)",
  },
  stageChipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
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
    fontFamily: "Inter_500Medium",
    color: C.accentDim,
    marginTop: 16,
  },
  errorContainer: {
    paddingTop: 40,
  },
  errorCard: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 32,
    alignItems: "center",
    gap: 12,
  },
  errorTitle: {
    fontSize: 20,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  errorMessage: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 20,
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: C.accentMuted,
    marginTop: 8,
  },
  retryText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: C.accent,
  },
  resultContainer: {
    paddingTop: 16,
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    backgroundColor: C.surface,
    borderRadius: 14,
    padding: 14,
    alignItems: "center",
  },
  statValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: C.accent,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: C.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  warningCard: {
    backgroundColor: "rgba(255, 183, 77, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 183, 77, 0.35)",
    borderRadius: 14,
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
    fontFamily: "Inter_600SemiBold",
    color: C.warning,
  },
  warningText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 17,
  },
  previewContainer: {
    backgroundColor: C.surface,
    borderRadius: 16,
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
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  previewHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
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
    borderRadius: 14,
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
    borderRadius: 12,
    marginBottom: 12,
  },
  activityText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  saveButton: {
    backgroundColor: C.accent,
  },
  saveButtonText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#0A0E17",
  },
  shareButton: {
    backgroundColor: C.accentMuted,
    borderWidth: 1,
    borderColor: "rgba(0, 212, 170, 0.3)",
  },
  shareButtonText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: C.accent,
  },
  newVideoButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: C.surface,
    marginBottom: 20,
  },
  newVideoText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: "rgba(0, 212, 170, 0.25)",
    marginBottom: 12,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: C.accent,
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
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  settingsPanel: {
    backgroundColor: C.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    gap: 8,
  },
  settingLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
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
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    opacity: 0.7,
    marginTop: 2,
  },
  chipButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: C.background,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
  },
  chipButtonActive: {
    backgroundColor: "rgba(0, 212, 170, 0.15)",
    borderColor: C.accent,
  },
  chipText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  chipTextActive: {
    color: C.accent,
  },
  etaText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    marginTop: 2,
    opacity: 0.8,
  },
  cropPanel: {
    backgroundColor: C.surface,
    borderRadius: 16,
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
    fontFamily: "Inter_600SemiBold",
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
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  cropStepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.background,
    borderRadius: 10,
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
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  cropApplyBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: C.accent,
  },
  cropApplyText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#0A0E17",
  },
  cropPanelLocked: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  cropPanelLockedText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  proLockBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "rgba(0,212,170,0.12)",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  proLockText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
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
    backgroundColor: "#1A1F2E",
    borderRadius: 24,
    padding: 28,
    width: "100%",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  upgradeIconBg: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  upgradeTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: C.text,
    marginBottom: 10,
  },
  upgradeBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  upgradeBtn: {
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    marginBottom: 12,
  },
  upgradeBtnGrad: {
    paddingVertical: 16,
    alignItems: "center",
  },
  upgradeBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#0A0E17",
  },
  upgradeDismiss: {
    paddingVertical: 8,
  },
  upgradeDismissText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
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
    backgroundColor: "rgba(0,212,170,0.12)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  subscriptionBadgeText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: C.accent,
  },
  subscriptionPlanLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: C.text,
  },
  subscriptionRenewal: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  manageSubBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "rgba(0,212,170,0.1)",
    borderWidth: 1,
    borderColor: "rgba(0,212,170,0.25)",
  },
  manageSubBtnText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: C.accent,
  },
  upgradeInlineBtn: {
    borderRadius: 12,
    overflow: "hidden",
  },
  upgradeInlineBtnGrad: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
  },
  upgradeInlineBtnText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#0A0E17",
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
    fontFamily: "Inter_500Medium",
    color: C.textTertiary,
  },
  settingsDivider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.06)",
    marginVertical: 4,
  },
  subErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,71,87,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,71,87,0.25)",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  subErrorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.75)",
  },
  subErrorRetryBtn: {
    backgroundColor: "rgba(0,212,170,0.15)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  subErrorRetryText: {
    color: C.accent,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
});
