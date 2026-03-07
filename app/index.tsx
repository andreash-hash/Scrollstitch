import React, { useState, useEffect, useRef, useCallback } from "react";
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
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather, Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import * as VideoThumbnails from "expo-video-thumbnails";
import Animated, {
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
import Colors from "@/constants/colors";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const C = Colors.dark;

type ProcessingStage =
  | "idle"
  | "extracting"
  | "uploading"
  | "processing"
  | "complete"
  | "error";

interface ProcessingResult {
  imageUrl: string;
  pdfUrl: string;
  frameCount: number;
  uniqueFrames: number;
  dimensions: { width: number; height: number };
}

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
    animatedWidth.value = withSpring(progress * 100, {
      damping: 15,
      stiffness: 100,
    });
  }, [progress]);
  const barStyle = useAnimatedStyle(() => ({
    width: `${animatedWidth.value}%` as any,
  }));
  return (
    <View style={styles.progressBarContainer}>
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

async function extractFramesFromVideo(
  uri: string,
  durationMs: number,
  onProgress: (current: number, total: number) => void
): Promise<string[]> {
  const intervalMs = 500;
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

export default function ScrollSnapScreen() {
  const insets = useSafeAreaInsets();
  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [frameCount, setFrameCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const buttonScale = useSharedValue(1);

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  const buttonAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const cleanupPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanupPolling;
  }, [cleanupPolling]);

  const pollProgress = useCallback(
    (jobId: string) => {
      const baseUrl = getApiUrl();
      pollRef.current = setInterval(async () => {
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

          setProgress(data.progress || 0);

          if (data.stage === "Removing duplicates") {
            setStatusText("Detecting duplicate frames...");
          } else if (data.stage === "Stitching frames") {
            setStatusText("Stitching unique frames together...");
            setProgress(0.6);
          } else if (data.stage === "Generating PDF") {
            setStatusText("Creating PDF document...");
            setProgress(0.85);
          }

          if (data.stage === "Complete" && data.result) {
            cleanupPolling();
            setStage("complete");
            setProgress(1);
            setResult(data.result);
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success
            );
          }
        } catch {}
      }, 500);
    },
    [cleanupPolling]
  );

  const pickVideo = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const permResult =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permResult.granted) {
        Alert.alert(
          "Permission needed",
          "Please grant access to your media library to pick videos."
        );
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
      const estimatedFrames = Math.ceil(durationMs / 500);

      setStage("extracting");
      setProgress(0);
      setFrameCount(0);
      setStatusText(`Extracting ~${estimatedFrames} frames...`);
      setResult(null);
      setErrorMessage("");

      const frameUris = await extractFramesFromVideo(
        asset.uri,
        durationMs,
        (current, total) => {
          setFrameCount(current);
          setProgress((current / total) * 0.15);
          setStatusText(`Extracting frames: ${current}/${total}`);
        }
      );

      if (frameUris.length === 0) {
        throw new Error("Could not extract any frames from the video");
      }

      setStage("uploading");
      setStatusText(`Uploading ${frameUris.length} frames...`);
      setProgress(0.15);

      const baseUrl = getApiUrl();
      const uploadUrl = new URL("/api/process-frames", baseUrl);

      if (Platform.OS === "web") {
        const formData = new FormData();
        for (let i = 0; i < frameUris.length; i++) {
          const response = await fetch(frameUris[i]);
          const blob = await response.blob();
          formData.append("frames", blob, `frame_${i.toString().padStart(5, "0")}.jpg`);
        }
        const uploadRes = await fetch(uploadUrl.toString(), {
          method: "POST",
          body: formData,
        });
        if (!uploadRes.ok) throw new Error(await uploadRes.text());
        const data = await uploadRes.json();

        setStage("processing");
        setProgress(0.3);
        setStatusText("Processing frames on server...");
        pollProgress(data.jobId);
      } else {
        const { fetch: expoFetch } = await import("expo/fetch");
        const { File: ExpoFile } = await import("expo-file-system");
        const formData = new FormData();

        for (let i = 0; i < frameUris.length; i++) {
          const file = new ExpoFile(frameUris[i]);
          formData.append("frames", file as any);
        }

        const uploadRes = await expoFetch(uploadUrl.toString(), {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) throw new Error(await uploadRes.text());
        const data = await uploadRes.json();

        setStage("processing");
        setProgress(0.3);
        setStatusText("Processing frames on server...");
        pollProgress(data.jobId);
      }
    } catch (err: any) {
      setStage("error");
      setErrorMessage(err.message || "Failed to process video");
    }
  };

  const downloadFile = async (urlPath: string, filename: string): Promise<string> => {
    const baseUrl = getApiUrl();
    const fileUrl = new URL(urlPath, baseUrl).toString();
    const cacheDir = FileSystem.cacheDirectory || "";
    const localUri = cacheDir + filename;
    const result = await FileSystem.downloadAsync(fileUrl, localUri);
    return result.uri;
  };

  const saveToPhotos = async () => {
    if (!result) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Please grant access to save images.");
        return;
      }
      const localUri = await downloadFile(result.imageUrl, `scrollsnap_${Date.now()}.png`);
      await MediaLibrary.saveToLibraryAsync(localUri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved", "Image saved to your photo library.");
    } catch (err: any) {
      console.error("Save error:", err);
      Alert.alert("Error", String(err?.message || err));
    }
  };

  const sharePdf = async () => {
    if (!result) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const localUri = await downloadFile(result.pdfUrl, `scrollsnap_${Date.now()}.pdf`);
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
    }
  };

  const reset = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    cleanupPolling();
    setStage("idle");
    setProgress(0);
    setStatusText("");
    setResult(null);
    setErrorMessage("");
    setFrameCount(0);
  };

  const isProcessing =
    stage === "extracting" || stage === "uploading" || stage === "processing";

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="scan-outline" size={22} color={C.accent} />
          <Text style={styles.headerTitle}>ScrollSnap</Text>
        </View>
        {(stage === "complete" || stage === "error") && (
          <Pressable onPress={reset} style={styles.headerButton}>
            <Feather name="rotate-ccw" size={20} color={C.textSecondary} />
          </Pressable>
        )}
      </View>

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
                Pick a screen recording and we'll extract the unique frames,
                stitch them together, and create a seamless long image or PDF.
              </Text>
            </View>

            <Animated.View style={buttonAnimStyle}>
              <Pressable
                onPress={pickVideo}
                onPressIn={() => {
                  buttonScale.value = withSpring(0.96);
                }}
                onPressOut={() => {
                  buttonScale.value = withSpring(1);
                }}
                style={styles.pickButton}
              >
                <LinearGradient
                  colors={[C.accent, "#00E5B8"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.pickButtonGradient}
                >
                  <Feather name="video" size={22} color="#0A0E17" />
                  <Text style={styles.pickButtonText}>Pick Video</Text>
                </LinearGradient>
              </Pressable>
            </Animated.View>

            <View style={styles.stepsContainer}>
              {[
                { icon: "film" as const, label: "Select recording" },
                { icon: "layers" as const, label: "Extract frames" },
                { icon: "scissors" as const, label: "Remove duplicates" },
                { icon: "image" as const, label: "Stitch & export" },
              ].map((step, i) => (
                <View key={i} style={styles.stepRow}>
                  <View style={styles.stepIcon}>
                    <Feather name={step.icon} size={16} color={C.accent} />
                  </View>
                  <Text style={styles.stepLabel}>{step.label}</Text>
                </View>
              ))}
            </View>
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

              <View style={styles.stageIndicators}>
                {[
                  { key: "extracting", label: "Extract" },
                  { key: "uploading", label: "Upload" },
                  { key: "processing", label: "Process" },
                ].map((s) => {
                  const stageOrder = ["extracting", "uploading", "processing"];
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
            <View style={styles.errorCard}>
              <Feather name="alert-circle" size={40} color={C.danger} />
              <Text style={styles.errorTitle}>Processing Failed</Text>
              <Text style={styles.errorMessage}>{errorMessage}</Text>
              <Pressable onPress={reset} style={styles.retryButton}>
                <Feather name="rotate-ccw" size={18} color={C.accent} />
                <Text style={styles.retryText}>Try Again</Text>
              </Pressable>
            </View>
          </Animated.View>
        )}

        {stage === "complete" && result && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.resultContainer}>
            <View style={styles.statsRow}>
              <View style={styles.statCard}>
                <Text style={styles.statValue}>{result.frameCount}</Text>
                <Text style={styles.statLabel}>Total Frames</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statValue}>{result.uniqueFrames}</Text>
                <Text style={styles.statLabel}>Unique</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statValue}>
                  {result.dimensions.width}x{result.dimensions.height}
                </Text>
                <Text style={styles.statLabel}>Size</Text>
              </View>
            </View>

            <View style={styles.previewContainer}>
              <Text style={styles.previewLabel}>Preview</Text>
              <ScrollView
                style={styles.previewScroll}
                contentContainerStyle={styles.previewContent}
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
              >
                <Image
                  source={{
                    uri: new URL(result.imageUrl, getApiUrl()).toString(),
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

            <View style={styles.actionButtons}>
              <Pressable
                onPress={saveToPhotos}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.saveButton,
                  pressed && styles.actionButtonPressed,
                ]}
              >
                <Feather name="download" size={20} color="#0A0E17" />
                <Text style={styles.saveButtonText}>Save to Photos</Text>
              </Pressable>

              <Pressable
                onPress={sharePdf}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.shareButton,
                  pressed && styles.actionButtonPressed,
                ]}
              >
                <Feather name="share" size={20} color={C.accent} />
                <Text style={styles.shareButtonText}>Share as PDF</Text>
              </Pressable>
            </View>

            <Pressable onPress={pickVideo} style={styles.newVideoButton}>
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
    marginBottom: 40,
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
  previewContainer: {
    backgroundColor: C.surface,
    borderRadius: 16,
    overflow: "hidden",
    marginBottom: 20,
  },
  previewLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
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
});
