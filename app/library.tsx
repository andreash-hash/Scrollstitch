import React, { useCallback, useState } from "react";
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
  Modal,
} from "react-native";
import { Image } from "expo-image";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather, Ionicons } from "@expo/vector-icons";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  loadLibrary,
  deleteStitch,
  clearLibrary,
  stitchImageUri,
  stitchDisplayUri,
  libraryBytes,
  formatBytes,
  type StitchRecord,
} from "@/lib/library";
import { preparePdf } from "@/lib/stitch-files";
import Colors from "@/constants/colors";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const C = Colors.dark;

/** "Today, 10:32" / "Yesterday, 18:04" / "12 Sep, 09:15" */
function formatWhen(ms: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - date.getTime()) / 86_400_000);
  if (days < 0) return `Today, ${time}`;
  if (days === 0) return `Yesterday, ${time}`;
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${day}, ${time}`;
}

export default function LibraryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [records, setRecords] = useState<StitchRecord[] | null>(null);
  const [selected, setSelected] = useState<StitchRecord | null>(null);
  const [busy, setBusy] = useState<"saving" | "sharing" | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      loadLibrary().then((list) => {
        if (!cancelled) setRecords(list);
      });
      return () => {
        cancelled = true;
      };
    }, [])
  );

  const confirmDelete = (record: StitchRecord) => {
    Alert.alert(
      "Delete this stitch?",
      "It will be removed from this device. Anything you already saved to Photos stays.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const remaining = await deleteStitch(record.id);
            setRecords(remaining);
            setSelected((current) => (current?.id === record.id ? null : current));
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
      ]
    );
  };

  const confirmClear = () => {
    Alert.alert(
      "Delete all stitches?",
      "Every stitch saved on this device will be removed. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete all",
          style: "destructive",
          onPress: async () => {
            await clearLibrary();
            setRecords([]);
            setSelected(null);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
      ]
    );
  };

  const saveToPhotos = async (record: StitchRecord) => {
    if (busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBusy("saving");
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Please grant access to save images.");
        return;
      }
      // Straight from the device's own copy — no network, so this works
      // whatever has happened to the server since.
      await MediaLibrary.saveToLibraryAsync(stitchImageUri(record));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved", "Image saved to your photo library.");
    } catch (err: any) {
      Alert.alert("Error", String(err?.message || err));
    } finally {
      setBusy(null);
    }
  };

  const sharePdf = async (record: StitchRecord) => {
    if (busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBusy("sharing");
    try {
      // The only action that still needs the server: PDFs are rendered there.
      // The stitch is sent back up and rendered fresh, however old it is.
      const localUri = await preparePdf(stitchImageUri(record), null);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localUri, {
          mimeType: "application/pdf",
          dialogTitle: "Share ScrollStitch PDF",
        });
      } else {
        Alert.alert("Sharing not available on this device");
      }
    } catch (err: any) {
      Alert.alert("Couldn't build the PDF", String(err?.message || err));
    } finally {
      setBusy(null);
    }
  };

  const totalBytes = libraryBytes(records ?? []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={24} color={C.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Saved Stitches</Text>
        {records && records.length > 0 ? (
          <Pressable
            onPress={confirmClear}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel="Delete all saved stitches"
          >
            <Feather name="trash-2" size={19} color={C.textSecondary} />
          </Pressable>
        ) : (
          <View style={styles.headerButton} />
        )}
      </View>

      {records === null ? (
        <View style={styles.centered}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : records.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="scan-outline" size={40} color={C.textTertiary} />
          <Text style={styles.emptyTitle}>No stitches yet</Text>
          <Text style={styles.emptyBody}>
            Every stitch you make is kept here on your device, so you can come back to
            it later.
          </Text>
          <Pressable
            onPress={() => router.back()}
            style={styles.emptyBtn}
            accessibilityRole="button"
            accessibilityLabel="Make a stitch"
          >
            <Text style={styles.emptyBtnText}>Make a stitch</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.list,
            { paddingBottom: Math.max(insets.bottom, 16) + 16 },
          ]}
        >
          <Text style={styles.storageLine}>
            {records.length} stitch{records.length === 1 ? "" : "es"} · {formatBytes(totalBytes)} on
            this device
          </Text>

          {records.map((record, index) => (
            <Animated.View key={record.id} entering={FadeIn.delay(index * 40)}>
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelected(record);
                }}
                style={styles.row}
                accessibilityRole="button"
                accessibilityLabel={`Stitch from ${formatWhen(record.createdAt)}, ${record.width} by ${record.height} pixels`}
                accessibilityHint="Opens the stitch"
              >
                <Image
                  source={{ uri: stitchDisplayUri(record) }}
                  style={styles.thumb}
                  contentFit="cover"
                  contentPosition="top"
                  transition={150}
                />
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{formatWhen(record.createdAt)}</Text>
                  <Text style={styles.rowMeta}>
                    {record.width}×{record.height} · {formatBytes(record.bytes)}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {record.selectedFrames} frame{record.selectedFrames === 1 ? "" : "s"}
                    {record.gapCount > 0
                      ? ` · ${record.gapCount} gap${record.gapCount === 1 ? "" : "s"}`
                      : ""}
                  </Text>
                </View>
                <Pressable
                  onPress={() => confirmDelete(record)}
                  hitSlop={10}
                  style={styles.rowDelete}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete stitch from ${formatWhen(record.createdAt)}`}
                >
                  <Feather name="trash-2" size={17} color={C.textTertiary} />
                </Pressable>
              </Pressable>
            </Animated.View>
          ))}
        </ScrollView>
      )}

      <Modal
        visible={selected !== null}
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
        {selected && (
          <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
              <Pressable
                onPress={() => setSelected(null)}
                style={styles.headerButton}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Feather name="x" size={22} color={C.text} />
              </Pressable>
              <Text style={styles.headerTitle}>{formatWhen(selected.createdAt)}</Text>
              <Pressable
                onPress={() => confirmDelete(selected)}
                style={styles.headerButton}
                accessibilityRole="button"
                accessibilityLabel="Delete this stitch"
              >
                <Feather name="trash-2" size={19} color={C.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              style={styles.viewerScroll}
              contentContainerStyle={styles.viewerContent}
              maximumZoomScale={Platform.OS === "ios" ? 6 : 1}
              minimumZoomScale={1}
              bouncesZoom
            >
              <Image
                accessible
                accessibilityRole="image"
                accessibilityLabel={`Stitched screenshot, ${selected.width} by ${selected.height} pixels`}
                source={{ uri: stitchDisplayUri(selected) }}
                style={{
                  width: SCREEN_WIDTH - 32,
                  height: ((SCREEN_WIDTH - 32) / selected.width) * selected.height,
                }}
                contentFit="contain"
                transition={200}
              />
            </ScrollView>

            <View
              style={[
                styles.viewerActions,
                { paddingBottom: Math.max(insets.bottom, 12) },
              ]}
            >
              <Pressable
                onPress={() => saveToPhotos(selected)}
                style={[styles.primaryBtn, busy === "saving" && styles.btnBusy]}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel="Save to Photos"
                accessibilityState={{ disabled: busy !== null }}
              >
                {busy === "saving" ? (
                  <ActivityIndicator color={C.onAccent} size="small" />
                ) : (
                  <>
                    <Feather name="download" size={17} color={C.onAccent} />
                    <Text style={styles.primaryBtnText}>Save to Photos</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                onPress={() => sharePdf(selected)}
                style={[styles.secondaryBtn, busy === "sharing" && styles.btnBusy]}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel="Share as PDF"
                accessibilityState={{ disabled: busy !== null }}
              >
                {busy === "sharing" ? (
                  <ActivityIndicator color={C.accent} size="small" />
                ) : (
                  <>
                    <Feather name="share" size={17} color={C.accent} />
                    <Text style={styles.secondaryBtnText}>Share as PDF</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        )}
      </Modal>
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
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: C.border,
  },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Archivo_800ExtraBold",
    color: C.text,
    textTransform: "uppercase",
    letterSpacing: -0.01,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: "Archivo_600SemiBold",
    color: C.text,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
    color: C.textSecondary,
    textAlign: "center",
  },
  emptyBtn: {
    marginTop: 8,
    backgroundColor: C.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  emptyBtnText: {
    color: C.onAccent,
    fontSize: 15,
    fontFamily: "Archivo_600SemiBold",
  },
  list: {
    padding: 16,
    gap: 12,
  },
  storageLine: {
    fontSize: 12,
    color: C.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.surface,
    borderWidth: 2,
    borderColor: C.border,
    padding: 10,
  },
  thumb: {
    width: 54,
    height: 72,
    backgroundColor: C.neutral200,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontFamily: "Archivo_600SemiBold",
    color: C.text,
  },
  rowMeta: {
    fontSize: 12,
    color: C.textSecondary,
  },
  rowDelete: {
    padding: 6,
  },
  viewerScroll: {
    flex: 1,
  },
  viewerContent: {
    padding: 16,
    alignItems: "center",
  },
  viewerActions: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 2,
    borderTopColor: C.border,
  },
  primaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 50,
    backgroundColor: C.accent,
  },
  primaryBtnText: {
    color: C.onAccent,
    fontSize: 15,
    fontFamily: "Archivo_600SemiBold",
  },
  secondaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 50,
    backgroundColor: C.accentMuted,
    borderWidth: 2,
    borderColor: C.accent,
  },
  secondaryBtnText: {
    color: C.accent,
    fontSize: 15,
    fontFamily: "Archivo_600SemiBold",
  },
  btnBusy: {
    opacity: 0.7,
  },
});
