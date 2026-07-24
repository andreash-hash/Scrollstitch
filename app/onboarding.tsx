import React, { useRef, useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  FlatList,
  Dimensions,
  StatusBar,
  ViewToken,
  Modal,
  ActivityIndicator,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withTiming,
  withSequence,
  withDelay,
  FadeIn,
  FadeInDown,
  FadeInUp,
  interpolate,
  Extrapolation,
  useAnimatedScrollHandler,
  runOnJS,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";
import Colors from "@/constants/colors";
import { useAppContext } from "@/contexts/AppContext";
import { useSubscription } from "@/lib/revenuecat";
import { PurchasesPackage } from "react-native-purchases";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const C = Colors.dark;

const webTopInset = Platform.OS === "web" ? 67 : 0;
const webBottomInset = Platform.OS === "web" ? 34 : 0;

// ─── Slide Illustrations ──────────────────────────────────────────────────────

function HeroIllustration() {
  const scale = useSharedValue(0.5);
  const glow = useSharedValue(0);

  useEffect(() => {
    scale.value = withSpring(1, { damping: 12, stiffness: 100 });
    glow.value = withRepeat(withSequence(
      withTiming(1, { duration: 1800 }),
      withTiming(0.4, { duration: 1800 }),
    ), -1, false);
  }, []);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: glow.value * 0.35,
    transform: [{ scale: interpolate(glow.value, [0, 1], [1, 1.18], Extrapolation.CLAMP) }],
  }));

  return (
    <View style={illu.heroWrap}>
      <Animated.View style={[illu.heroGlowOuter, glowStyle]} />
      <Animated.View style={iconStyle}>
        <LinearGradient
          colors={[C.accent, "#00E5B8"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={illu.heroIcon}
        >
          <Ionicons name="scan-outline" size={52} color="#0A0E17" />
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

function PickIllustration() {
  const dot = useSharedValue(1);
  const float = useSharedValue(0);

  useEffect(() => {
    dot.value = withRepeat(withSequence(
      withTiming(0.2, { duration: 500 }),
      withTiming(1, { duration: 500 }),
    ), -1, false);
    float.value = withRepeat(withSequence(
      withTiming(-6, { duration: 1600 }),
      withTiming(0, { duration: 1600 }),
    ), -1, false);
  }, []);

  const dotStyle = useAnimatedStyle(() => ({ opacity: dot.value }));
  const floatStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: float.value }],
  }));

  return (
    <View style={illu.pickWrap}>
      <Animated.View style={[illu.phone, floatStyle]}>
        <View style={illu.phoneSpeaker} />
        <View style={illu.phoneScreen}>
          {[["#1a2744", "#243456"], ["#1a2744", "#1a2744"], ["#243456", "#1a2744"], ["#1a2744", "#243456"]].map(([a, b], i) => (
            <View key={i} style={illu.phoneRow}>
              <View style={[illu.phoneBar, { backgroundColor: a, flex: 1.3 }]} />
              <View style={[illu.phoneBar, { backgroundColor: b, flex: 0.7 }]} />
            </View>
          ))}
        </View>
        <View style={illu.phoneHome} />
        <Animated.View style={[illu.recDot, dotStyle]}>
          <View style={illu.recDotInner} />
        </Animated.View>
        <Text style={illu.recLabel}>REC</Text>
      </Animated.View>
    </View>
  );
}

function ExtractIllustration() {
  const f1 = useSharedValue(0);
  const f2 = useSharedValue(0);
  const f3 = useSharedValue(0);
  const f4 = useSharedValue(0);
  const arrow = useSharedValue(0);
  const out = useSharedValue(0);

  useEffect(() => {
    f1.value = withDelay(0, withSpring(1, { damping: 14 }));
    f2.value = withDelay(150, withSpring(1, { damping: 14 }));
    f3.value = withDelay(300, withSpring(1, { damping: 14 }));
    f4.value = withDelay(450, withSpring(1, { damping: 14 }));
    arrow.value = withDelay(700, withTiming(1, { duration: 400 }));
    out.value = withDelay(900, withSpring(1, { damping: 14 }));
  }, []);

  const s1 = useAnimatedStyle(() => ({ opacity: f1.value, transform: [{ scale: f1.value }] }));
  const s2 = useAnimatedStyle(() => ({ opacity: f2.value, transform: [{ scale: f2.value }] }));
  const s3 = useAnimatedStyle(() => ({ opacity: f3.value * 0.35, transform: [{ scale: f3.value }] }));
  const s4 = useAnimatedStyle(() => ({ opacity: f4.value * 0.35, transform: [{ scale: f4.value }] }));
  const arrowStyle = useAnimatedStyle(() => ({ opacity: arrow.value }));
  const outStyle = useAnimatedStyle(() => ({ opacity: out.value, transform: [{ scale: out.value }] }));

  return (
    <View style={illu.extractWrap}>
      <View style={illu.extractGrid}>
        <Animated.View style={[illu.frame, s1]}><View style={illu.frameInner} /></Animated.View>
        <Animated.View style={[illu.frame, s2]}><View style={illu.frameInner} /></Animated.View>
        <Animated.View style={[illu.frame, illu.frameDup, s3]}><View style={illu.frameInner} /></Animated.View>
        <Animated.View style={[illu.frame, illu.frameDup, s4]}><View style={illu.frameInner} /></Animated.View>
      </View>
      <Animated.View style={[illu.arrow, arrowStyle]}>
        <Feather name="arrow-right" size={22} color={C.accent} />
      </Animated.View>
      <View style={illu.extractOut}>
        <Animated.View style={[illu.frame, illu.frameUniq, outStyle]}><View style={illu.frameInner} /></Animated.View>
        <Animated.View style={[illu.frame, illu.frameUniq, outStyle]}><View style={illu.frameInner} /></Animated.View>
      </View>
    </View>
  );
}

function ExportIllustration() {
  const height = useSharedValue(0);
  const badge = useSharedValue(0);

  useEffect(() => {
    height.value = withSpring(1, { damping: 16, stiffness: 60 });
    badge.value = withDelay(600, withSpring(1, { damping: 12 }));
  }, []);

  const stripStyle = useAnimatedStyle(() => ({
    height: interpolate(height.value, [0, 1], [0, 200], Extrapolation.CLAMP),
  }));
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: badge.value,
    transform: [{ scale: badge.value }],
  }));

  return (
    <View style={illu.exportWrap}>
      <View style={illu.exportDoc}>
        <Animated.View style={[illu.exportStrip, stripStyle]}>
          {[C.surface, "#1C2333", C.surface, "#1C2333", C.surface, "#1C2333", C.surface].map((bg, i) => (
            <View key={i} style={[illu.exportRow, { backgroundColor: bg }]} />
          ))}
        </Animated.View>
      </View>
      <Animated.View style={[illu.exportBadge, badgeStyle]}>
        <LinearGradient colors={[C.accent, "#00E5B8"]} style={illu.exportBadgeGrad}>
          <Feather name="file-text" size={14} color="#0A0E17" />
          <Text style={illu.exportBadgeText}>PDF</Text>
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

// ─── Slide Data ───────────────────────────────────────────────────────────────

const SLIDES = [
  {
    id: "hero",
    tag: "WELCOME",
    title: "Stop taking 12\nscreenshots",
    subtitle: "Scroll once, record it — and get one long image or PDF you can share with Claude, ChatGPT, or friends.",
    illustration: HeroIllustration,
  },
  {
    id: "pick",
    tag: "STEP 1",
    title: "Record the thread,\nchat, or doc",
    subtitle: "Reddit debate, long DM, a page you want to save — just scroll through it while recording. That's it.",
    illustration: PickIllustration,
  },
  {
    id: "extract",
    tag: "STEP 2",
    title: "We cut out all\nthe repeated frames",
    subtitle: "Every paused or duplicate moment is removed automatically. Only the new content makes it through.",
    illustration: ExtractIllustration,
  },
  {
    id: "export",
    tag: "STEP 3",
    title: "One image to drop\ninto any AI or chat",
    subtitle: "Send the full conversation to Claude or ChatGPT in a single file. Or share it with a friend as a PDF.",
    illustration: ExportIllustration,
  },
];

// ─── Individual Slide ─────────────────────────────────────────────────────────

interface SlideProps {
  item: (typeof SLIDES)[number];
  index: number;
}

function OnboardingSlide({ item, index }: SlideProps) {
  const Illustration = item.illustration;
  return (
    <View style={[slide.container, { width: SCREEN_WIDTH }]}>
      <Animated.View entering={FadeIn.delay(index * 60).duration(500)} style={slide.illuWrap}>
        <Illustration />
      </Animated.View>
      <Animated.View entering={FadeInUp.delay(index * 60 + 100).duration(500)} style={slide.textWrap}>
        <Text style={slide.tag}>{item.tag}</Text>
        <Text style={slide.title}>{item.title}</Text>
        <Text style={slide.subtitle}>{item.subtitle}</Text>
      </Animated.View>
    </View>
  );
}

// ─── Paywall Slide ────────────────────────────────────────────────────────────

const PRO_FEATURES = [
  { icon: "film" as const, text: "Unlimited recordings, any scroll length" },
  { icon: "layers" as const, text: "Export as PNG, JPEG or PDF" },
  { icon: "crop" as const, text: "Trim sticky headers & footers" },
  { icon: "sliders" as const, text: "Fine-tune dedup sensitivity" },
  { icon: "zap" as const, text: "Priority processing" },
];

function PaywallSlide({
  onContinueFree,
  monthlyPackage,
  annualPackage,
  onPurchase,
  onRestore,
  isPurchasing,
  isRestoring,
}: {
  onContinueFree: () => void;
  monthlyPackage: PurchasesPackage | null;
  annualPackage: PurchasesPackage | null;
  onPurchase: (pkg: PurchasesPackage) => void;
  onRestore: () => void;
  isPurchasing: boolean;
  isRestoring: boolean;
}) {
  const [billing, setBilling] = useState<"monthly" | "annual">("annual");
  const [confirmVisible, setConfirmVisible] = useState(false);
  const btnScale = useSharedValue(1);

  const btnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: btnScale.value }],
  }));

  const selectedPackage = billing === "monthly" ? monthlyPackage : annualPackage;

  const monthlyPrice = monthlyPackage?.product.priceString ?? "$4.99";
  const annualPrice = annualPackage?.product.priceString ?? "$29.99";

  const handleCtaPress = () => {
    btnScale.value = withSequence(withSpring(0.96), withSpring(1));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (__DEV__) {
      setConfirmVisible(true);
    } else if (selectedPackage) {
      onPurchase(selectedPackage);
    }
  };

  return (
    <View style={[paywall.container, { width: SCREEN_WIDTH }]}>
      <Animated.View entering={FadeInDown.duration(400)}>
        <View style={paywall.header}>
          <LinearGradient
            colors={["rgba(0,212,170,0.2)", "rgba(0,212,170,0.04)"]}
            style={paywall.iconBg}
          >
            <Ionicons name="star" size={26} color={C.accent} />
          </LinearGradient>
          <Text style={paywall.title}>Go Pro</Text>
          <Text style={paywall.sub}>Capture anything. Share everywhere.</Text>
        </View>

        <View style={paywall.features}>
          {PRO_FEATURES.map((f, i) => (
            <Animated.View
              key={f.text}
              entering={FadeInDown.delay(i * 60).duration(380)}
              style={paywall.featureRow}
            >
              <View style={paywall.featureIcon}>
                <Feather name={f.icon} size={15} color={C.accent} />
              </View>
              <Text style={paywall.featureText}>{f.text}</Text>
            </Animated.View>
          ))}
        </View>

        <View style={paywall.billingToggle}>
          {(["monthly", "annual"] as const).map((b) => (
            <Pressable
              key={b}
              onPress={() => setBilling(b)}
              style={[paywall.billingChip, billing === b && paywall.billingChipActive]}
            >
              <Text style={[paywall.billingChipText, billing === b && paywall.billingChipTextActive]}>
                {b === "monthly" ? `${monthlyPrice} / mo` : `${annualPrice} / yr`}
              </Text>
              {b === "annual" && (
                <View style={paywall.saveBadge}>
                  <Text style={paywall.saveBadgeText}>SAVE 50%</Text>
                </View>
              )}
            </Pressable>
          ))}
        </View>

        <Animated.View style={btnStyle}>
          <Pressable
            onPress={handleCtaPress}
            disabled={isPurchasing || !selectedPackage}
            style={paywall.ctaWrap}
          >
            <LinearGradient
              colors={[C.accent, "#00E5B8"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={paywall.cta}
            >
              {isPurchasing ? (
                <ActivityIndicator size="small" color="#0A0E17" />
              ) : (
                <Text style={paywall.ctaText}>
                  Subscribe — {billing === "monthly" ? monthlyPrice + "/mo" : annualPrice + "/yr"}
                </Text>
              )}
            </LinearGradient>
          </Pressable>
        </Animated.View>

        <Pressable onPress={onContinueFree} style={paywall.skip}>
          <Text style={paywall.skipText}>Continue with limited access</Text>
        </Pressable>

        <Pressable
          onPress={onRestore}
          disabled={isRestoring}
          style={paywall.restoreWrap}
        >
          {isRestoring ? (
            <ActivityIndicator size="small" color={C.textTertiary} />
          ) : (
            <Text style={paywall.restoreText}>Restore Purchases</Text>
          )}
        </Pressable>

        <Text style={paywall.legal}>
          Subscription auto-renews. Cancel anytime in Settings.
        </Text>
      </Animated.View>

      {/* Custom confirmation modal for dev/test mode */}
      <Modal
        visible={confirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmVisible(false)}
      >
        <View style={paywall.modalOverlay}>
          <View style={paywall.modalCard}>
            <Text style={paywall.modalTitle}>Confirm Purchase</Text>
            <Text style={paywall.modalBody}>
              {`You are in test mode. Confirm purchase of the ${billing} plan (${billing === "monthly" ? monthlyPrice + "/mo" : annualPrice + "/yr"})?`}
            </Text>
            <View style={paywall.modalActions}>
              <Pressable
                onPress={() => setConfirmVisible(false)}
                style={[paywall.modalBtn, paywall.modalBtnCancel]}
              >
                <Text style={paywall.modalBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setConfirmVisible(false);
                  if (selectedPackage) onPurchase(selectedPackage);
                }}
                style={[paywall.modalBtn, paywall.modalBtnConfirm]}
              >
                <Text style={paywall.modalBtnConfirmText}>Confirm</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Dot Indicator ────────────────────────────────────────────────────────────

function Dots({ count, active }: { count: number; active: number }) {
  return (
    <View style={dots.row}>
      {Array.from({ length: count }).map((_, i) => (
        <View
          key={i}
          style={[dots.dot, active === i && dots.dotActive]}
        />
      ))}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

const TOTAL = SLIDES.length + 1; // slides + paywall

export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { markOnboardingComplete } = useAppContext();
  const { monthlyPackage, annualPackage, purchase, restore, isPurchasing, isRestoring } = useSubscription();
  const listRef = useRef<FlatList>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const isPaywall = activeIndex === SLIDES.length;

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems[0]?.index != null) {
        setActiveIndex(viewableItems[0].index);
      }
    },
    []
  );

  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 50 });

  const goNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    listRef.current?.scrollToIndex({ index: activeIndex + 1, animated: true });
  };

  const handlePurchase = async (pkg: PurchasesPackage) => {
    try {
      await purchase(pkg);
      await markOnboardingComplete();
      router.replace("/");
    } catch (err: any) {
      if (err?.userCancelled) return;
      console.error("Purchase failed:", err?.message);
    }
  };

  const handleRestore = async () => {
    try {
      await restore();
      await markOnboardingComplete();
      router.replace("/");
    } catch (err: any) {
      console.error("Restore failed:", err?.message);
    }
  };

  const handleContinueFree = async () => {
    await markOnboardingComplete();
    router.replace("/");
  };

  const renderItem = useCallback(
    ({ item, index }: { item: (typeof SLIDES)[number] | "paywall"; index: number }) => {
      if (item === "paywall") {
        return (
          <PaywallSlide
            onContinueFree={handleContinueFree}
            monthlyPackage={monthlyPackage}
            annualPackage={annualPackage}
            onPurchase={handlePurchase}
            onRestore={handleRestore}
            isPurchasing={isPurchasing}
            isRestoring={isRestoring}
          />
        );
      }
      return <OnboardingSlide item={item} index={index} />;
    },
    [monthlyPackage, annualPackage, isPurchasing, isRestoring]
  );

  const data: ((typeof SLIDES)[number] | "paywall")[] = [...SLIDES, "paywall"];

  return (
    <View
      style={[
        container.root,
        {
          paddingTop: insets.top + webTopInset,
          paddingBottom: insets.bottom + webBottomInset,
        },
      ]}
    >
      <StatusBar barStyle="light-content" />

      {!isPaywall && (
        <Pressable
          onPress={handleContinueFree}
          style={[container.skip, { top: insets.top + webTopInset + 10 }]}
        >
          <Text style={container.skipText}>Skip</Text>
        </Pressable>
      )}

      <FlatList
        ref={listRef}
        data={data}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderItem}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig.current}
        scrollEventThrottle={16}
        getItemLayout={(_, index) => ({
          length: SCREEN_WIDTH,
          offset: SCREEN_WIDTH * index,
          index,
        })}
        style={container.list}
      />

      {!isPaywall && (
        <View style={container.footer}>
          <Dots count={SLIDES.length} active={activeIndex} />
          <Pressable
            onPress={goNext}
            style={container.nextBtn}
          >
            <LinearGradient
              colors={[C.accent, "#00E5B8"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={container.nextGrad}
            >
              {activeIndex < SLIDES.length - 1 ? (
                <Feather name="arrow-right" size={22} color="#0A0E17" />
              ) : (
                <Text style={container.getStarted}>Get Started</Text>
              )}
            </LinearGradient>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const illu = StyleSheet.create({
  heroWrap: {
    alignItems: "center",
    justifyContent: "center",
    height: 180,
  },
  heroGlowOuter: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: C.accent,
  },
  heroIcon: {
    width: 110,
    height: 110,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  pickWrap: {
    alignItems: "center",
    justifyContent: "center",
    height: 180,
  },
  phone: {
    width: 100,
    height: 170,
    borderRadius: 18,
    borderWidth: 2.5,
    borderColor: "rgba(255,255,255,0.15)",
    backgroundColor: C.background,
    overflow: "hidden",
    alignItems: "center",
  },
  phoneSpeaker: {
    width: 30,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.15)",
    marginTop: 10,
    marginBottom: 6,
  },
  phoneScreen: {
    flex: 1,
    width: "100%",
    padding: 6,
    gap: 5,
  },
  phoneRow: {
    flexDirection: "row",
    gap: 4,
    height: 18,
  },
  phoneBar: {
    borderRadius: 3,
    height: 18,
  },
  phoneHome: {
    width: 28,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.15)",
    marginBottom: 8,
  },
  recDot: {
    position: "absolute",
    top: 18,
    right: 10,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#FF4757",
    alignItems: "center",
    justifyContent: "center",
  },
  recDotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FF6B78",
  },
  recLabel: {
    position: "absolute",
    top: 17,
    right: 22,
    fontSize: 7,
    fontFamily: "Inter_700Bold",
    color: "#FF4757",
    letterSpacing: 0.5,
  },
  extractWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 180,
    gap: 16,
  },
  extractGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    width: 120,
    gap: 6,
  },
  frame: {
    width: 54,
    height: 72,
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "rgba(0,212,170,0.4)",
  },
  frameDup: {
    borderColor: "rgba(255,255,255,0.12)",
  },
  frameUniq: {
    width: 54,
    height: 72,
    borderColor: C.accent,
    marginBottom: 6,
  },
  frameInner: {
    flex: 1,
    backgroundColor: C.surface,
  },
  arrow: {
    alignItems: "center",
    justifyContent: "center",
  },
  extractOut: {
    alignItems: "center",
    gap: 6,
  },
  exportWrap: {
    alignItems: "center",
    justifyContent: "center",
    height: 180,
  },
  exportDoc: {
    width: 90,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "rgba(0,212,170,0.3)",
    backgroundColor: C.surface,
  },
  exportStrip: {
    overflow: "hidden",
  },
  exportRow: {
    height: 28,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,212,170,0.08)",
  },
  exportBadge: {
    position: "absolute",
    bottom: 8,
    right: -10,
  },
  exportBadgeGrad: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  exportBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: "#0A0E17",
    letterSpacing: 0.5,
  },
});

const slide = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 32,
    justifyContent: "center",
    gap: 32,
  },
  illuWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  textWrap: {
    gap: 12,
  },
  tag: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: C.accent,
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 30,
    fontFamily: "Inter_700Bold",
    color: C.text,
    lineHeight: 36,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 22,
  },
});

const paywall = StyleSheet.create({
  container: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    gap: 8,
    marginBottom: 24,
  },
  iconBg: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: C.text,
    letterSpacing: -0.5,
  },
  sub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  features: {
    gap: 10,
    marginBottom: 24,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  featureIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: "rgba(0,212,170,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  featureText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: C.text,
    flex: 1,
  },
  billingToggle: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  billingChip: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    backgroundColor: C.surface,
    gap: 4,
  },
  billingChipActive: {
    borderColor: C.accent,
    backgroundColor: "rgba(0,212,170,0.1)",
  },
  billingChipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
  },
  billingChipTextActive: {
    color: C.accent,
  },
  saveBadge: {
    backgroundColor: C.accent,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  saveBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#0A0E17",
    letterSpacing: 0.5,
  },
  ctaWrap: {
    borderRadius: 16,
    overflow: "hidden",
    marginBottom: 12,
  },
  cta: {
    paddingVertical: 17,
    alignItems: "center",
  },
  ctaText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#0A0E17",
    letterSpacing: 0.2,
  },
  skip: {
    alignItems: "center",
    paddingVertical: 12,
  },
  skipText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  restoreWrap: {
    alignItems: "center",
    paddingVertical: 6,
  },
  restoreText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textTertiary,
    textDecorationLine: "underline",
  },
  legal: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: C.textTertiary,
    textAlign: "center",
    lineHeight: 14,
    marginTop: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  modalCard: {
    backgroundColor: "#1A1F2E",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: C.text,
    marginBottom: 10,
    textAlign: "center",
  },
  modalBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: "row",
    gap: 12,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  modalBtnCancel: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  modalBtnConfirm: {
    backgroundColor: C.accent,
  },
  modalBtnCancelText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
  },
  modalBtnConfirmText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#0A0E17",
  },
});

const dots = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  dotActive: {
    width: 22,
    borderRadius: 3,
    backgroundColor: C.accent,
  },
});

const container = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.background,
  },
  list: {
    flex: 1,
  },
  skip: {
    position: "absolute",
    right: 24,
    zIndex: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  skipText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 32,
    paddingVertical: 20,
  },
  nextBtn: {
    borderRadius: 50,
    overflow: "hidden",
  },
  nextGrad: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  getStarted: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#0A0E17",
    letterSpacing: 0.2,
  },
});
