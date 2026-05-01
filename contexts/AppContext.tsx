import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const ONBOARDING_KEY = "@scrollsnap/onboarding_complete";
const PRO_KEY = "@scrollsnap/is_pro";

interface AppContextType {
  hasSeenOnboarding: boolean;
  isPro: boolean;
  isLoading: boolean;
  markOnboardingComplete: () => Promise<void>;
  resetOnboarding: () => Promise<void>;
  upgradeToPro: () => Promise<void>;
  downgradeToFree: () => Promise<void>;
}

const AppContext = createContext<AppContextType>({
  hasSeenOnboarding: false,
  isPro: false,
  isLoading: true,
  markOnboardingComplete: async () => {},
  resetOnboarding: async () => {},
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
        const [onb, pro] = await Promise.all([
          AsyncStorage.getItem(ONBOARDING_KEY),
          AsyncStorage.getItem(PRO_KEY),
        ]);
        setHasSeenOnboarding(onb === "true");
        setIsPro(pro === "true");
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

  const upgradeToPro = async () => {
    await AsyncStorage.setItem(PRO_KEY, "true");
    setIsPro(true);
  };

  const downgradeToFree = async () => {
    await AsyncStorage.setItem(PRO_KEY, "false");
    setIsPro(false);
  };

  return (
    <AppContext.Provider
      value={{
        hasSeenOnboarding,
        isPro,
        isLoading,
        markOnboardingComplete,
        resetOnboarding,
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
