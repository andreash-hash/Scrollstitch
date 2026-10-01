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
import { Feather, Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { Platform, Linking } from "react-native";
import Colors from "@/constants/colors";
import { useAppContext } from "@/contexts/AppContext";
import { useSubscription, REVENUECAT_ENTITLEMENT_IDENTIFIER } from "@/lib/revenuecat";
import { getApiUrl } from "@/lib/query-client";
import { PurchasesPackage } from "react-native-purchases";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const C = Colors.dark;

// Apple's standard EULA — required link on an auto-renewing subscription
// paywall unless the app ships its own terms.
const TERMS_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";

/** Lifetime is a one-time purchase; the other two renew. */
type Plan = "weekly" | "annual" | "lifetime";

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
        <View style={illu.heroIcon}>
          <Ionicons name="scan-outline" size={52} color="#f3f2f2" />
        </View>
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
          {[["#d7d3d3", "#bab6b6"], ["#d7d3d3", "#d7d3d3"], ["#bab6b6", "#d7d3d3"], ["#d7d3d3", "#bab6b6"]].map(([a, b], i) => (
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
          {[C.surface, "#eae9e9", C.surface, "#eae9e9", C.surface, "#eae9e9", C.surface].map((bg, i) => (
            <View key={i} style={[illu.exportRow, { backgroundColor: bg }]} />
          ))}
        </Animated.View>
      </View>
      <Animated.View style={[illu.exportBadge, badgeStyle]}>
        <View style={illu.exportBadgeGrad}>
          <Feather name="file-text" size={14} color="#f3f2f2" />
          <Text style={illu.exportBadgeText}>PDF</Text>
        </View>
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
  { icon: "image" as const, text: "One clean image instead of 12 screenshots" },
  { icon: "message-square" as const, text: "Send a whole chat without cropping" },
  { icon: "file-text" as const, text: "Save receipts and threads as PDF" },
  { icon: "crop" as const, text: "No repeated headers, no duplicated content" },
  { icon: "repeat" as const, text: "Any length, as many as you like" },
];

function PaywallSkeletonRow() {
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(withTiming(1, { duration: 700 }), withTiming(0.4, { duration: 700 })),
      -1,
      false
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View style={[paywall.skeletonRow, animStyle]} />
  );
}

function PaywallSlide({
  weeklyPackage,
  annualPackage,
  lifetimePackage,
  trialDays,
  onPurchase,
  onRestore,
  isPurchasing,
  isRestoring,
  offeringsIsLoading,
  offeringsIsError,
  onRetryOfferings,
  purchaseError,
}: {
  weeklyPackage: PurchasesPackage | null;
  annualPackage: PurchasesPackage | null;
  lifetimePackage: PurchasesPackage | null;
  trialDays: number | null;
  onPurchase: (pkg: PurchasesPackage) => void;
  onRestore: () => void;
  isPurchasing: boolean;
  isRestoring: boolean;
  offeringsIsLoading: boolean;
  offeringsIsError: boolean;
  onRetryOfferings: () => void;
  purchaseError: string | null;
}) {
  const [billing, setBilling] = useState<Plan>("weekly");
  const [confirmVisible, setConfirmVisible] = useState(false);
  const btnScale = useSharedValue(1);

  const btnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: btnScale.value }],
  }));

  // RevenueCat drops a package from the offering when the store cannot return
  // its product — an unapproved subscription in App Store Connect, or products
  // that never got attached to the package. Rendering a chip for it anyway
  // produced a plan priced "…" next to a button that could not be pressed. Only
  // offer what the store actually returned.
  const availablePlans = ([] as Plan[]).concat(
    weeklyPackage ? ["weekly"] : [],
    annualPackage ? ["annual"] : [],
    lifetimePackage ? ["lifetime"] : []
  );
  const noPlansAvailable = availablePlans.length === 0;
  const effectiveBilling = availablePlans.includes(billing) ? billing : availablePlans[0];

  const packageFor: Record<Plan, PurchasesPackage | null> = {
    weekly: weeklyPackage,
    annual: annualPackage,
    lifetime: lifetimePackage,
  };
  const selectedPackage = packageFor[effectiveBilling];

  const weeklyPrice = weeklyPackage?.product.priceString ?? "";
  const annualPrice = annualPackage?.product.priceString ?? "";
  const lifetimePrice = lifetimePackage?.product.priceString ?? "";
  const priceFor: Record<Plan, string> = {
    weekly: weeklyPrice, annual: annualPrice, lifetime: lifetimePrice,
  };
  // Lifetime is bought once. Saying "per" anything about it would be a lie,
  // and Apple checks that subscription terms match what is actually sold.
  const periodFor: Record<Plan, string> = {
    weekly: "per week", annual: "per year", lifetime: "one-time",
  };
  const isSubscriptionPlan = effectiveBilling !== "lifetime";
  // Only promise a trial when the store actually offers one on the weekly plan
  const showTrial = effectiveBilling === "weekly" && trialDays != null && trialDays > 0;

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
          <View style={paywall.iconBg}>
            <Ionicons name="star" size={26} color={C.accent} />
          </View>
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

        {/* Billing toggle & CTA — skeleton/error/ready states */}
        {offeringsIsLoading ? (
          <View style={paywall.skeletonWrap}>
            <PaywallSkeletonRow />
            <PaywallSkeletonRow />
            <PaywallSkeletonRow />
          </View>
        ) : offeringsIsError || noPlansAvailable ? (
          <View style={paywall.errorWrap}>
            <Feather name="wifi-off" size={22} color={C.textTertiary} />
            <Text style={paywall.errorText}>
              Couldn&apos;t load pricing. Check your connection and try again.
            </Text>
            <Pressable
              onPress={onRetryOfferings}
              style={paywall.retryBtn}
              accessibilityRole="button"
              accessibilityLabel="Retry loading pricing"
            >
              <Text style={paywall.retryBtnText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View
              style={paywall.billingToggle}
              accessibilityRole="radiogroup"
              accessibilityLabel="Choose a plan"
            >
              {availablePlans.map((b) => (
                <Pressable
                  key={b}
                  onPress={() => setBilling(b)}
                  style={[
                    paywall.billingChip,
                    effectiveBilling === b && paywall.billingChipActive,
                  ]}
                  accessibilityRole="radio"
                  accessibilityLabel={
                    b === "lifetime"
                      ? `Lifetime, ${lifetimePrice}, one-time purchase`
                      : b === "weekly"
                        ? `Weekly plan, ${weeklyPrice} per week${trialDays ? `, ${trialDays} days free first` : ""}`
                        : `Annual plan, ${annualPrice} per year, best value`
                  }
                  accessibilityState={{ selected: effectiveBilling === b }}
                >
                  <Text
                    style={[
                      paywall.billingChipText,
                      effectiveBilling === b && paywall.billingChipTextActive,
                    ]}
                  >
                    {priceFor[b]}
                  </Text>
                  <Text
                    style={[
                      paywall.billingChipPeriod,
                      effectiveBilling === b && paywall.billingChipTextActive,
                    ]}
                  >
                    {periodFor[b]}
                  </Text>
                  {b === "annual" && availablePlans.length > 2 && (
                    <View style={paywall.saveBadge}>
                      <Text style={paywall.saveBadgeText}>BEST VALUE</Text>
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
                accessibilityRole="button"
                accessibilityLabel={
                  isPurchasing
                    ? "Processing purchase"
                    : showTrial
                      ? `Start ${trialDays} days free, then ${weeklyPrice} per week`
                      : effectiveBilling === "lifetime"
                        ? `Buy ScrollStitch Pro for ${lifetimePrice}, one-time payment`
                        : `Subscribe for ${priceFor[effectiveBilling]} ${periodFor[effectiveBilling]}`
                }
                accessibilityState={{
                  disabled: isPurchasing || !selectedPackage,
                  busy: isPurchasing,
                }}
              >
                <View style={paywall.cta}>
                  {isPurchasing ? (
                    <ActivityIndicator size="small" color="#f3f2f2" />
                  ) : (
                    <Text style={paywall.ctaText}>
                      {showTrial
                        ? `Start ${trialDays} days free`
                        : effectiveBilling === "lifetime"
                          ? `Buy once — ${lifetimePrice}`
                          : `Subscribe — ${priceFor[effectiveBilling]}`}
                    </Text>
                  )}
                </View>
              </Pressable>
            </Animated.View>
          </>
        )}

        {/* A purchase can succeed at the store and still not grant access —
            an unvalidated receipt leaves the entitlement off. The router sends
            anyone without it back here, so without this message the app looks
            frozen rather than failed. */}
        {purchaseError && (
          <View style={paywall.errorWrap} accessibilityLiveRegion="polite">
            <Feather name="alert-circle" size={22} color={C.textTertiary} />
            <Text style={paywall.errorText}>{purchaseError}</Text>
          </View>
        )}

        <Pressable
          onPress={onRestore}
          disabled={isRestoring}
          style={paywall.restoreWrap}
          accessibilityRole="button"
          accessibilityLabel="Restore purchases"
          accessibilityState={{ disabled: isRestoring, busy: isRestoring }}
        >
          {isRestoring ? (
            <ActivityIndicator size="small" color={C.textTertiary} />
          ) : (
            <Text style={paywall.restoreText}>Restore Purchases</Text>
          )}
        </Pressable>

        <Text style={paywall.legal}>
          {!isSubscriptionPlan
            ? `${lifetimePrice} once. This is a one-time purchase, not a subscription — nothing renews and there is nothing to cancel.`
            : showTrial
              ? `${trialDays} days free, then ${weeklyPrice} per week. Auto-renews until cancelled; cancel anytime in Settings at least 24 hours before renewal.`
              : `${priceFor[effectiveBilling]} ${periodFor[effectiveBilling]}. Auto-renews until cancelled; cancel anytime in Settings.`}
        </Text>

        <View style={paywall.legalLinks}>
          <Pressable
            onPress={() => Linking.openURL(TERMS_URL)}
            accessibilityRole="link"
            accessibilityLabel="Terms of Use"
          >
            <Text style={paywall.legalLink}>Terms of Use</Text>
          </Pressable>
          <Text style={paywall.legalDot}>·</Text>
          <Pressable
            onPress={() => Linking.openURL(new URL("/privacy", getApiUrl()).toString())}
            accessibilityRole="link"
            accessibilityLabel="Privacy Policy"
          >
            <Text style={paywall.legalLink}>Privacy Policy</Text>
          </Pressable>
        </View>
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
              {`You are in test mode. Confirm purchase of the ${effectiveBilling} plan (${priceFor[effectiveBilling]} ${periodFor[effectiveBilling]})?`}
            </Text>
            <View style={paywall.modalActions}>
              <Pressable
                onPress={() => setConfirmVisible(false)}
                style={[paywall.modalBtn, paywall.modalBtnCancel]}
                accessibilityRole="button"
                accessibilityLabel="Cancel purchase"
              >
                <Text style={paywall.modalBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setConfirmVisible(false);
                  if (selectedPackage) onPurchase(selectedPackage);
                }}
                style={[paywall.modalBtn, paywall.modalBtnConfirm]}
                accessibilityRole="button"
                accessibilityLabel="Confirm purchase"
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
  const { directPaywall } = useLocalSearchParams<{ directPaywall?: string }>();
  const { markOnboardingComplete } = useAppContext();
  const { weeklyPackage, annualPackage, lifetimePackage, trialDays, purchase, restore, isPurchasing, isRestoring, offeringsIsLoading, offeringsIsError, refetchOfferings } = useSubscription();
  const listRef = useRef<FlatList>(null);
  const initialIndex = directPaywall === "1" ? SLIDES.length : 0;
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  // When opened directly to the paywall, scroll the FlatList there immediately
  // (initial state already reflects the paywall, but the list renders at offset 0)
  useEffect(() => {
    if (directPaywall === "1") {
      // Use a short delay so the FlatList has laid out before we scroll
      const t = setTimeout(() => {
        listRef.current?.scrollToIndex({ index: SLIDES.length, animated: false });
      }, 50);
      return () => clearTimeout(t);
    }
  }, []);

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
    setPurchaseError(null);
    try {
      const info = await purchase(pkg);

      // Paying is not the same as being granted access. If the receipt cannot
      // be validated the store still reports a completed purchase while the
      // entitlement stays off, and the router — which sends anyone without it
      // back to this screen — would bounce the navigation below straight back
      // here. Saying so beats looking frozen.
      if (!info?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER]) {
        setPurchaseError(
          "Your purchase went through, but we couldn't confirm access. Nothing was lost — tap Restore Purchases, or reopen the app in a moment."
        );
        return;
      }

      await markOnboardingComplete();
      router.replace("/");
    } catch (err: any) {
      if (err?.userCancelled) return;
      setPurchaseError(err?.message || "The purchase didn't complete. Please try again.");
    }
  };

  const handleRestore = async () => {
    setPurchaseError(null);
    try {
      const info = await restore();
      if (!info?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER]) {
        setPurchaseError("We couldn't find an active purchase on this Apple ID.");
        return;
      }
      await markOnboardingComplete();
      router.replace("/");
    } catch (err: any) {
      setPurchaseError(err?.message || "Restore didn't complete. Please try again.");
    }
  };

  // The paywall is hard, so skipping the intro means going straight to the
  // plans rather than into the app.
  const handleSkipToPlans = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    listRef.current?.scrollToIndex({ index: SLIDES.length, animated: true });
  };

  const renderItem = useCallback(
    ({ item, index }: { item: (typeof SLIDES)[number] | "paywall"; index: number }) => {
      if (item === "paywall") {
        return (
          <PaywallSlide
            weeklyPackage={weeklyPackage}
            annualPackage={annualPackage}
            lifetimePackage={lifetimePackage}
            trialDays={trialDays}
            onPurchase={handlePurchase}
            onRestore={handleRestore}
            isPurchasing={isPurchasing}
            isRestoring={isRestoring}
            offeringsIsLoading={offeringsIsLoading}
            offeringsIsError={offeringsIsError}
            onRetryOfferings={refetchOfferings}
            purchaseError={purchaseError}
          />
        );
      }
      return <OnboardingSlide item={item} index={index} />;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weeklyPackage, annualPackage, lifetimePackage, trialDays, isPurchasing, isRestoring, offeringsIsLoading, offeringsIsError, refetchOfferings, purchaseError]
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
      <StatusBar barStyle="dark-content" />

      {!isPaywall && (
        <Pressable
          onPress={handleSkipToPlans}
          style={[container.skip, { top: insets.top + webTopInset + 10 }]}
          accessibilityRole="button"
          accessibilityLabel="Skip to plans"
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
            accessibilityRole="button"
            accessibilityLabel={
              activeIndex < SLIDES.length - 1 ? "Next slide" : "Continue to plans"
            }
          >
            <View style={container.nextGrad}>
              {activeIndex < SLIDES.length - 1 ? (
                <Feather name="arrow-right" size={22} color="#f3f2f2" />
              ) : (
                <Text style={container.getStarted}>Get Started</Text>
              )}
            </View>
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
    borderRadius: 0,
    backgroundColor: C.accent,
  },
  heroIcon: {
    backgroundColor: C.accent,
    width: 110,
    height: 110,
    borderRadius: 0,
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
    borderRadius: 0,
    borderWidth: 2.5,
    borderColor: "rgba(32,30,29,0.15)",
    backgroundColor: C.background,
    overflow: "hidden",
    alignItems: "center",
  },
  phoneSpeaker: {
    width: 30,
    height: 4,
    borderRadius: 0,
    backgroundColor: "rgba(32,30,29,0.15)",
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
    borderRadius: 0,
    height: 18,
  },
  phoneHome: {
    width: 28,
    height: 4,
    borderRadius: 0,
    backgroundColor: "rgba(32,30,29,0.15)",
    marginBottom: 8,
  },
  recDot: {
    position: "absolute",
    top: 18,
    right: 10,
    width: 10,
    height: 10,
    borderRadius: 0,
    backgroundColor: "#ae1800",
    alignItems: "center",
    justifyContent: "center",
  },
  recDotInner: {
    width: 6,
    height: 6,
    borderRadius: 0,
    backgroundColor: "#c94b39",
  },
  recLabel: {
    position: "absolute",
    top: 17,
    right: 22,
    fontSize: 7,
    fontFamily: "Archivo_800ExtraBold",
    color: "#ae1800",
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
    borderRadius: 0,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "rgba(236,48,19,0.4)",
  },
  frameDup: {
    borderColor: "rgba(32,30,29,0.12)",
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
    borderRadius: 0,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "rgba(236,48,19,0.3)",
    backgroundColor: C.surface,
  },
  exportStrip: {
    overflow: "hidden",
  },
  exportRow: {
    height: 28,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(236,48,19,0.08)",
  },
  exportBadge: {
    position: "absolute",
    bottom: 8,
    right: -10,
  },
  exportBadgeGrad: {
    backgroundColor: C.accent,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 0,
  },
  exportBadgeText: {
    fontSize: 11,
    fontFamily: "Archivo_800ExtraBold",
    color: "#f3f2f2",
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
    fontFamily: "Archivo_800ExtraBold",
    color: C.accent,
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 30,
    fontFamily: "Archivo_800ExtraBold",
    color: C.text,
    lineHeight: 36,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: "Archivo_400Regular",
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
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    fontFamily: "Archivo_800ExtraBold",
    color: C.text,
    letterSpacing: -0.5,
  },
  sub: {
    fontSize: 14,
    fontFamily: "Archivo_400Regular",
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
    borderRadius: 0,
    backgroundColor: "rgba(236,48,19,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  featureText: {
    fontSize: 14,
    fontFamily: "Archivo_400Regular",
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
    borderRadius: 0,
    borderWidth: 1.5,
    borderColor: "rgba(32,30,29,0.1)",
    alignItems: "center",
    backgroundColor: C.surface,
    gap: 4,
  },
  billingChipActive: {
    borderColor: C.accent,
    backgroundColor: "rgba(236,48,19,0.1)",
  },
  billingChipPeriod: {
    fontSize: 11,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
    marginTop: 1,
  },
  billingChipText: {
    fontSize: 13,
    fontFamily: "Archivo_600SemiBold",
    color: C.textSecondary,
  },
  billingChipTextActive: {
    color: C.accent,
  },
  saveBadge: {
    backgroundColor: C.accent,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 0,
  },
  saveBadgeText: {
    fontSize: 9,
    fontFamily: "Archivo_800ExtraBold",
    color: "#f3f2f2",
    letterSpacing: 0.5,
  },
  ctaWrap: {
    backgroundColor: C.accent,
    borderRadius: 0,
    overflow: "hidden",
    marginBottom: 12,
  },
  cta: {
    paddingVertical: 17,
    alignItems: "center",
  },
  ctaText: {
    fontSize: 16,
    fontFamily: "Archivo_800ExtraBold",
    color: "#f3f2f2",
    letterSpacing: 0.2,
  },
  skip: {
    alignItems: "center",
    paddingVertical: 12,
  },
  skipText: {
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
  },
  restoreWrap: {
    alignItems: "center",
    paddingVertical: 6,
  },
  restoreText: {
    fontSize: 12,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
    textDecorationLine: "underline",
  },
  legal: {
    fontSize: 10,
    fontFamily: "Archivo_400Regular",
    color: C.textTertiary,
    textAlign: "center",
    lineHeight: 14,
    marginTop: 4,
    paddingHorizontal: 8,
  },
  legalLinks: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
  },
  legalLink: {
    fontSize: 11,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
    textDecorationLine: "underline",
    paddingVertical: 4,
  },
  legalDot: {
    fontSize: 11,
    color: C.textTertiary,
  },
  skeletonWrap: {
    gap: 10,
    marginBottom: 20,
  },
  skeletonRow: {
    height: 52,
    borderRadius: 0,
    backgroundColor: "rgba(32,30,29,0.07)",
  },
  errorWrap: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 20,
    marginBottom: 12,
  },
  errorText: {
    fontSize: 13,
    fontFamily: "Archivo_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 19,
  },
  retryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 0,
    borderWidth: 1.5,
    borderColor: C.accent,
  },
  retryBtnText: {
    fontSize: 14,
    fontFamily: "Archivo_600SemiBold",
    color: C.accent,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  modalCard: {
    backgroundColor: "#eae9e9",
    borderRadius: 0,
    padding: 24,
    width: "100%",
    borderWidth: 1,
    borderColor: "rgba(32,30,29,0.08)",
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Archivo_800ExtraBold",
    color: C.text,
    marginBottom: 10,
    textAlign: "center",
  },
  modalBody: {
    fontSize: 14,
    fontFamily: "Archivo_400Regular",
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
    borderRadius: 0,
    alignItems: "center",
  },
  modalBtnCancel: {
    backgroundColor: "rgba(32,30,29,0.08)",
  },
  modalBtnConfirm: {
    backgroundColor: C.accent,
  },
  modalBtnCancelText: {
    fontSize: 14,
    fontFamily: "Archivo_600SemiBold",
    color: C.textSecondary,
  },
  modalBtnConfirmText: {
    fontSize: 14,
    fontFamily: "Archivo_800ExtraBold",
    color: "#f3f2f2",
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
    borderRadius: 0,
    backgroundColor: "rgba(32,30,29,0.2)",
  },
  dotActive: {
    width: 22,
    borderRadius: 0,
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
    fontFamily: "Archivo_400Regular",
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
    borderRadius: 0,
    overflow: "hidden",
  },
  nextGrad: {
    backgroundColor: C.accent,
    width: 56,
    height: 56,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  getStarted: {
    fontSize: 14,
    fontFamily: "Archivo_800ExtraBold",
    color: "#f3f2f2",
    letterSpacing: 0.2,
  },
});
