import {
  Archivo_400Regular,
  Archivo_600SemiBold,
  Archivo_800ExtraBold,
  useFonts,
} from "@expo-google-fonts/archivo";
import { Feather } from "@expo/vector-icons";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AppContextProvider, useAppContext } from "@/contexts/AppContext";
import { initializeRevenueCat, SubscriptionProvider, useSubscription } from "@/lib/revenuecat";
import { DeepLinkIapProvider } from "insert-affiliate-react-native-sdk";
import { InsertAffiliateSync } from "@/lib/insertAffiliate";
import Colors from "@/constants/colors";

SplashScreen.preventAutoHideAsync();

try {
  initializeRevenueCat();
} catch (err: any) {
  Alert.alert("RevenueCat Unavailable", err?.message ?? "Unknown error");
}

const C = Colors.dark;

/** Syncs RevenueCat subscription status into AppContext's isPro.
 *  Also renders a dismissible error banner when customerInfo can't be loaded. */
function SubscriptionSync() {
  const {
    isSubscribed,
    customerInfoIsError,
    customerInfoError,
    offeringsIsError,
    offeringsError,
    refetchCustomerInfo,
  } = useSubscription();
  const { setIsPro } = useAppContext();
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setIsPro(isSubscribed);
  }, [isSubscribed]);

  useEffect(() => {
    if (customerInfoIsError) {
      console.warn("[SubscriptionSync] Failed to fetch customer info:", customerInfoError);
      // Re-show the banner each time a new error arrives.
      setDismissed(false);
    }
  }, [customerInfoIsError, customerInfoError]);

  useEffect(() => {
    if (offeringsIsError) {
      console.warn("[SubscriptionSync] Failed to fetch offerings:", offeringsError);
    }
  }, [offeringsIsError, offeringsError]);

  const handleRetry = () => {
    setDismissed(true);
    refetchCustomerInfo();
  };

  if (!customerInfoIsError || dismissed) return null;

  return (
    <View
      style={[
        syncStyles.banner,
        { bottom: Math.max(insets.bottom, 8) + 8 },
      ]}
      pointerEvents="box-none"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={syncStyles.inner}>
        <Feather name="alert-circle" size={15} color={C.danger} style={syncStyles.icon} />
        <Text style={syncStyles.message} numberOfLines={2}>
          Couldn&apos;t load subscription info
        </Text>
        <Pressable
          onPress={handleRetry}
          style={syncStyles.retryBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Retry loading subscription info"
        >
          <Text style={syncStyles.retryText}>Retry</Text>
        </Pressable>
        <Pressable
          onPress={() => setDismissed(true)}
          style={syncStyles.closeBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        >
          <Feather name="x" size={14} color={C.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}

const syncStyles = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 999,
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#eae9e9",
    borderWidth: 1,
    borderColor: "rgba(174,24,0,0.35)",
    borderRadius: 0,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 8,
  },
  icon: {
    flexShrink: 0,
  },
  message: {
    flex: 1,
    color: "rgba(32,30,29,0.85)",
    fontSize: 13,
    lineHeight: 18,
  },
  retryBtn: {
    flexShrink: 0,
    backgroundColor: "rgba(236,48,19,0.15)",
    borderRadius: 0,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  retryText: {
    color: C.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  closeBtn: {
    flexShrink: 0,
    padding: 2,
  },
});

function RootLayoutNav() {
  const { hasSeenOnboarding, isLoading } = useAppContext();
  const { isSubscribed, customerInfoIsLoading } = useSubscription();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    // Wait for both the stored onboarding flag and the entitlement check —
    // redirecting early would flash the paywall at paying subscribers.
    if (isLoading || customerInfoIsLoading) return;

    const inOnboarding = segments[0] === "onboarding";

    // Hard paywall: without an active entitlement the only screen is the
    // onboarding flow, which ends in the plans.
    if (!isSubscribed) {
      if (!inOnboarding) router.replace("/onboarding");
      return;
    }

    // Subscribed: never hold them in onboarding, whether they just paid or
    // arrived with an entitlement already on the account.
    if (inOnboarding) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, customerInfoIsLoading, isSubscribed, hasSeenOnboarding, segments]);

  return (
    <>
      <SubscriptionSync />
      <InsertAffiliateSync />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="onboarding" options={{ animation: "fade" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Archivo_400Regular,
    Archivo_600SemiBold,
    Archivo_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ErrorBoundary>
      <AppContextProvider>
        <QueryClientProvider client={queryClient}>
          <SubscriptionProvider>
            <DeepLinkIapProvider>
              <GestureHandlerRootView>
                <KeyboardProvider>
                  <RootLayoutNav />
                </KeyboardProvider>
              </GestureHandlerRootView>
            </DeepLinkIapProvider>
          </SubscriptionProvider>
        </QueryClientProvider>
      </AppContextProvider>
    </ErrorBoundary>
  );
}
