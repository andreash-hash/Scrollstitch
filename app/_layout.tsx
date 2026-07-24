import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
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
    >
      <View style={syncStyles.inner}>
        <Feather name="alert-circle" size={15} color={C.danger} style={syncStyles.icon} />
        <Text style={syncStyles.message} numberOfLines={2}>
          Couldn't load subscription info
        </Text>
        <Pressable onPress={handleRetry} style={syncStyles.retryBtn} hitSlop={8}>
          <Text style={syncStyles.retryText}>Retry</Text>
        </Pressable>
        <Pressable onPress={() => setDismissed(true)} style={syncStyles.closeBtn} hitSlop={8}>
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
    backgroundColor: "#1C2333",
    borderWidth: 1,
    borderColor: "rgba(255,71,87,0.35)",
    borderRadius: 12,
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
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    lineHeight: 18,
  },
  retryBtn: {
    flexShrink: 0,
    backgroundColor: "rgba(0,212,170,0.15)",
    borderRadius: 8,
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
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (isLoading) return;
    const inOnboarding = segments[0] === "onboarding";
    if (!hasSeenOnboarding && !inOnboarding) {
      router.replace("/onboarding");
    } else if (hasSeenOnboarding && inOnboarding) {
      router.replace("/");
    }
  }, [isLoading, hasSeenOnboarding, segments]);

  return (
    <>
      <SubscriptionSync />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="onboarding" options={{ animation: "fade" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
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
            <GestureHandlerRootView>
              <KeyboardProvider>
                <RootLayoutNav />
              </KeyboardProvider>
            </GestureHandlerRootView>
          </SubscriptionProvider>
        </QueryClientProvider>
      </AppContextProvider>
    </ErrorBoundary>
  );
}
