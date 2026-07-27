import React, { createContext, useContext, useEffect, useRef } from "react";
import { AppState, AppStateStatus, Platform } from "react-native";
import Purchases, { PurchasesPackage } from "react-native-purchases";
import { useMutation, useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";

const REVENUECAT_TEST_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY;
const REVENUECAT_IOS_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
const REVENUECAT_ANDROID_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;

export const REVENUECAT_ENTITLEMENT_IDENTIFIER = "pro";

function getRevenueCatApiKey() {
  if (!REVENUECAT_TEST_API_KEY || !REVENUECAT_IOS_API_KEY || !REVENUECAT_ANDROID_API_KEY) {
    throw new Error("RevenueCat Public API Keys not found");
  }

  if (!REVENUECAT_ENTITLEMENT_IDENTIFIER) {
    throw new Error("RevenueCat Entitlement Identifier not provided");
  }

  if (__DEV__ || Platform.OS === "web" || Constants.executionEnvironment === "storeClient") {
    return REVENUECAT_TEST_API_KEY;
  }

  if (Platform.OS === "ios") {
    return REVENUECAT_IOS_API_KEY;
  }

  if (Platform.OS === "android") {
    return REVENUECAT_ANDROID_API_KEY;
  }

  return REVENUECAT_TEST_API_KEY;
}

export function initializeRevenueCat() {
  const apiKey = getRevenueCatApiKey();
  if (!apiKey) throw new Error("RevenueCat Public API Key not found");

  Purchases.setLogLevel(Purchases.LOG_LEVEL.DEBUG);
  Purchases.configure({ apiKey });

  console.log("Configured RevenueCat");
}

function useSubscriptionContext() {
  const customerInfoQuery = useQuery({
    queryKey: ["revenuecat", "customer-info"],
    queryFn: async () => {
      const info = await Purchases.getCustomerInfo();
      return info;
    },
    staleTime: 60 * 1000,
  });

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (appStateRef.current !== "active" && nextState === "active") {
        customerInfoQuery.refetch();
      }
      appStateRef.current = nextState;
    });
    return () => subscription.remove();
  }, [customerInfoQuery.refetch]);

  const offeringsQuery = useQuery({
    queryKey: ["revenuecat", "offerings"],
    queryFn: async () => {
      const offerings = await Purchases.getOfferings();
      return offerings;
    },
    staleTime: 300 * 1000,
  });

  const purchaseMutation = useMutation({
    mutationFn: async (packageToPurchase: PurchasesPackage) => {
      const { customerInfo } = await Purchases.purchasePackage(packageToPurchase);
      return customerInfo;
    },
    onSuccess: () => customerInfoQuery.refetch(),
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      return Purchases.restorePurchases();
    },
    onSuccess: () => customerInfoQuery.refetch(),
  });

  const activeEntitlement =
    customerInfoQuery.data?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER];
  const isSubscribed = activeEntitlement !== undefined;
  // Which plan they are actually on — the win-back offer only makes sense for
  // someone paying weekly.
  const activeProductId = activeEntitlement?.productIdentifier ?? null;
  const isAnnualSubscriber = activeProductId?.includes("annual") ?? false;

  // Weekly is the plan the trial funnels into; annual is the win-back offer.
  const currentOffering = offeringsQuery.data?.current;
  const weeklyPackage = currentOffering?.availablePackages.find(
    (pkg) => pkg.packageType === "WEEKLY" || pkg.identifier === "$rc_weekly"
  ) ?? null;
  const annualPackage = currentOffering?.availablePackages.find(
    (pkg) => pkg.packageType === "ANNUAL" || pkg.identifier === "$rc_annual"
  ) ?? null;

  // Introductory offer on the weekly product, when the store reports one and
  // this user is still eligible for it. Drives the "3 days free" copy — never
  // promise a trial the store will not actually grant.
  const weeklyIntro = weeklyPackage?.product.introPrice ?? null;
  const trialDays = weeklyIntro?.periodUnit === "DAY" ? weeklyIntro.periodNumberOfUnits : null;

  return {
    customerInfo: customerInfoQuery.data,
    offerings: offeringsQuery.data,
    currentOffering,
    weeklyPackage,
    annualPackage,
    weeklyIntro,
    trialDays,
    activeProductId,
    isAnnualSubscriber,
    isSubscribed,
    isLoading: customerInfoQuery.isLoading || offeringsQuery.isLoading,
    offeringsIsLoading: offeringsQuery.isLoading,
    offeringsIsError: offeringsQuery.isError,
    offeringsError: offeringsQuery.error,
    customerInfoIsError: customerInfoQuery.isError,
    customerInfoError: customerInfoQuery.error,
    customerInfoIsLoading: customerInfoQuery.isLoading,
    refetchCustomerInfo: customerInfoQuery.refetch,
    refetchOfferings: offeringsQuery.refetch,
    purchase: purchaseMutation.mutateAsync,
    restore: restoreMutation.mutateAsync,
    isPurchasing: purchaseMutation.isPending,
    isRestoring: restoreMutation.isPending,
  };
}

type SubscriptionContextValue = ReturnType<typeof useSubscriptionContext>;
const Context = createContext<SubscriptionContextValue | null>(null);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const value = useSubscriptionContext();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSubscription() {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error("useSubscription must be used within a SubscriptionProvider");
  }
  return ctx;
}
