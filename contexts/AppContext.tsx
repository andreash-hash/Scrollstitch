import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const ONBOARDING_KEY = "@scrollstitch/onboarding_complete";
const FIRST_LAUNCH_KEY = "@scrollstitch/first_launch_at";
const WINBACK_KEY = "@scrollstitch/winback_shown";
const STITCH_COUNT_KEY = "@scrollstitch/stitch_count";
const REVIEW_KEY = "@scrollstitch/review_prompted";

const DAY_MS = 24 * 60 * 60 * 1000;

interface AppContextType {
  hasSeenOnboarding: boolean;
  isPro: boolean;
  isLoading: boolean;
  /** Whole days since the app was first opened; 0 on the first day. */
  daysSinceFirstLaunch: number;
  /** Successful stitches on this device, used to time the review prompt. */
  stitchCount: number;
  winBackShown: boolean;
  reviewPrompted: boolean;
  markOnboardingComplete: () => Promise<void>;
  resetOnboarding: () => Promise<void>;
  setIsPro: (value: boolean) => void;
  recordSuccessfulStitch: () => Promise<number>;
  markWinBackShown: () => Promise<void>;
  markReviewPrompted: () => Promise<void>;
}

const AppContext = createContext<AppContextType>({
  hasSeenOnboarding: false,
  isPro: false,
  isLoading: true,
  daysSinceFirstLaunch: 0,
  stitchCount: 0,
  winBackShown: false,
  reviewPrompted: false,
  markOnboardingComplete: async () => {},
  resetOnboarding: async () => {},
  setIsPro: () => {},
  recordSuccessfulStitch: async () => 0,
  markWinBackShown: async () => {},
  markReviewPrompted: async () => {},
});

export function AppContextProvider({ children }: { children: React.ReactNode }) {
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);
  const [isPro, setIsPro] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [firstLaunchAt, setFirstLaunchAt] = useState<number | null>(null);
  const [stitchCount, setStitchCount] = useState(0);
  const [winBackShown, setWinBackShown] = useState(false);
  const [reviewPrompted, setReviewPrompted] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [onb, first, winback, count, review] = await AsyncStorage.multiGet([
          ONBOARDING_KEY,
          FIRST_LAUNCH_KEY,
          WINBACK_KEY,
          STITCH_COUNT_KEY,
          REVIEW_KEY,
        ]);
        setHasSeenOnboarding(onb[1] === "true");
        setWinBackShown(winback[1] === "true");
        setReviewPrompted(review[1] === "true");
        setStitchCount(Number(count[1]) || 0);

        // Stamp the first launch so the 3-day win-back has an anchor.
        const stamped = Number(first[1]);
        if (stamped > 0) {
          setFirstLaunchAt(stamped);
        } else {
          const now = Date.now();
          await AsyncStorage.setItem(FIRST_LAUNCH_KEY, String(now));
          setFirstLaunchAt(now);
        }
      } catch {
        // Storage unavailable — the app still works, it just forgets timing.
      }
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

  const recordSuccessfulStitch = async () => {
    const next = stitchCount + 1;
    setStitchCount(next);
    try {
      await AsyncStorage.setItem(STITCH_COUNT_KEY, String(next));
    } catch {}
    return next;
  };

  const markWinBackShown = async () => {
    setWinBackShown(true);
    try {
      await AsyncStorage.setItem(WINBACK_KEY, "true");
    } catch {}
  };

  const markReviewPrompted = async () => {
    setReviewPrompted(true);
    try {
      await AsyncStorage.setItem(REVIEW_KEY, "true");
    } catch {}
  };

  const daysSinceFirstLaunch =
    firstLaunchAt == null ? 0 : Math.floor((Date.now() - firstLaunchAt) / DAY_MS);

  return (
    <AppContext.Provider
      value={{
        hasSeenOnboarding,
        isPro,
        isLoading,
        daysSinceFirstLaunch,
        stitchCount,
        winBackShown,
        reviewPrompted,
        markOnboardingComplete,
        resetOnboarding,
        setIsPro,
        recordSuccessfulStitch,
        markWinBackShown,
        markReviewPrompted,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  return useContext(AppContext);
}
