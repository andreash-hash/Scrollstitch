import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const ONBOARDING_KEY = "@scrollsnap/onboarding_complete";

interface AppContextType {
  hasSeenOnboarding: boolean;
  isPro: boolean;
  isLoading: boolean;
  markOnboardingComplete: () => Promise<void>;
  resetOnboarding: () => Promise<void>;
  setIsPro: (value: boolean) => void;
  // Kept for backward compatibility (no-ops)
  upgradeToPro: () => Promise<void>;
  downgradeToFree: () => Promise<void>;
}

const AppContext = createContext<AppContextType>({
  hasSeenOnboarding: false,
  isPro: false,
  isLoading: true,
  markOnboardingComplete: async () => {},
  resetOnboarding: async () => {},
  setIsPro: () => {},
  upgradeToPro: async () => {},
  downgradeToFree: async () => {},
});

export function AppContextProvider({ children }: { children: React.ReactNode }) {
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);
  const [isPro, setIsPro] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const onb = await AsyncStorage.getItem(ONBOARDING_KEY);
        setHasSeenOnboarding(onb === "true");
      } catch {}
      setIsLoading(false);
    })();
  }, []);

  const markOnboardingComplete = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    setHasSeenOnboarding(true);
  };

  const resetOnboarding = async () => {
    await AsyncStorage.removeItem(ONBOARDING_KEY);
    setHasSeenOnboarding(false);
  };

  // No-ops: isPro is now driven by RevenueCat entitlement via SubscriptionSync
  const upgradeToPro = async () => {};
  const downgradeToFree = async () => {};

  return (
    <AppContext.Provider
      value={{
        hasSeenOnboarding,
        isPro,
        isLoading,
        markOnboardingComplete,
        resetOnboarding,
        setIsPro,
        upgradeToPro,
        downgradeToFree,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  return useContext(AppContext);
}
