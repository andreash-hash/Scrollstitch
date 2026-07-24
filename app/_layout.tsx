import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { Alert } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AppContextProvider, useAppContext } from "@/contexts/AppContext";
import { initializeRevenueCat, SubscriptionProvider, useSubscription } from "@/lib/revenuecat";

SplashScreen.preventAutoHideAsync();

try {
  initializeRevenueCat();
} catch (err: any) {
  Alert.alert("RevenueCat Unavailable", err?.message ?? "Unknown error");
}

/** Syncs RevenueCat subscription status into AppContext's isPro. */
function SubscriptionSync() {
  const { isSubscribed } = useSubscription();
  const { setIsPro } = useAppContext();

  useEffect(() => {
    setIsPro(isSubscribed);
  }, [isSubscribed]);

  return null;
}

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
