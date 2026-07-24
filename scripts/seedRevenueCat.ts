import { getUncachableRevenueCatClient } from "./revenueCatClient";

import {
  listProjects,
  createProject,
  listApps,
  createApp,
  listAppPublicApiKeys,
  listProducts,
  createProduct,
  listEntitlements,
  createEntitlement,
  attachProductsToEntitlement,
  listOfferings,
  createOffering,
  updateOffering,
  listPackages,
  createPackages,
  attachProductsToPackage,
  type App,
  type Product,
  type Project,
  type Entitlement,
  type Offering,
  type Package,
  type CreateProductData,
  type Duration,
} from "@replit/revenuecat-sdk";

const PROJECT_NAME = "ScrollSnap";

// Monthly product
const MONTHLY_IDENTIFIER = "scrollsnap_pro_monthly";
const MONTHLY_PLAY_STORE_IDENTIFIER = "scrollsnap_pro_monthly:monthly";
const MONTHLY_DISPLAY_NAME = "ScrollSnap Pro Monthly";
const MONTHLY_DURATION = "P1M" as const;

// Annual product
const ANNUAL_IDENTIFIER = "scrollsnap_pro_annual";
const ANNUAL_PLAY_STORE_IDENTIFIER = "scrollsnap_pro_annual:annual";
const ANNUAL_DISPLAY_NAME = "ScrollSnap Pro Annual";
const ANNUAL_DURATION = "P1Y" as const;

const APP_STORE_APP_NAME = "ScrollSnap iOS";
const APP_STORE_BUNDLE_ID = "com.myapp";
const PLAY_STORE_APP_NAME = "ScrollSnap Android";
const PLAY_STORE_PACKAGE_NAME = "com.myapp";

const ENTITLEMENT_IDENTIFIER = "pro";
const ENTITLEMENT_DISPLAY_NAME = "Pro Access";

const OFFERING_IDENTIFIER = "default";
const OFFERING_DISPLAY_NAME = "Default Offering";

// Monthly: $4.99 | Annual: $29.99
const MONTHLY_PRICES = [{ amount_micros: 4990000, currency: "USD" }];
const ANNUAL_PRICES = [{ amount_micros: 29990000, currency: "USD" }];

type TestStorePricesResponse = {
  object: string;
  prices: { amount_micros: number; currency: string }[];
};

async function seedRevenueCat() {
  const client = await getUncachableRevenueCatClient();

  // ── Project ──────────────────────────────────────────────────────────────
  let project: Project;
  const { data: existingProjects, error: listProjectsError } = await listProjects({
    client,
    query: { limit: 20 },
  });
  if (listProjectsError) throw new Error("Failed to list projects");

  const existingProject = existingProjects.items?.find((p) => p.name === PROJECT_NAME);
  if (existingProject) {
    console.log("Project already exists:", existingProject.id);
    project = existingProject;
  } else {
    const { data: newProject, error: createProjectError } = await createProject({
      client,
      body: { name: PROJECT_NAME },
    });
    if (createProjectError) throw new Error("Failed to create project");
    console.log("Created project:", newProject.id);
    project = newProject;
  }

  // ── Apps ─────────────────────────────────────────────────────────────────
  const { data: apps, error: listAppsError } = await listApps({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listAppsError || !apps || apps.items.length === 0) {
    throw new Error("No apps found");
  }

  let testStoreApp: App | undefined = apps.items.find((a) => a.type === "test_store");
  let appStoreApp: App | undefined = apps.items.find((a) => a.type === "app_store");
  let playStoreApp: App | undefined = apps.items.find((a) => a.type === "play_store");

  if (!testStoreApp) throw new Error("No app with test store found");
  console.log("App with test store found:", testStoreApp.id);

  if (!appStoreApp) {
    const { data: newApp, error } = await createApp({
      client,
      path: { project_id: project.id },
      body: {
        name: APP_STORE_APP_NAME,
        type: "app_store",
        app_store: { bundle_id: APP_STORE_BUNDLE_ID },
      },
    });
    if (error) throw new Error("Failed to create App Store app");
    appStoreApp = newApp;
    console.log("Created App Store app:", appStoreApp.id);
  } else {
    console.log("App Store app found:", appStoreApp.id);
  }

  if (!playStoreApp) {
    const { data: newApp, error } = await createApp({
      client,
      path: { project_id: project.id },
      body: {
        name: PLAY_STORE_APP_NAME,
        type: "play_store",
        play_store: { package_name: PLAY_STORE_PACKAGE_NAME },
      },
    });
    if (error) throw new Error("Failed to create Play Store app");
    playStoreApp = newApp;
    console.log("Created Play Store app:", playStoreApp.id);
  } else {
    console.log("Play Store app found:", playStoreApp.id);
  }

  // ── Products ──────────────────────────────────────────────────────────────
  const { data: existingProducts, error: listProductsError } = await listProducts({
    client,
    path: { project_id: project.id },
    query: { limit: 100 },
  });
  if (listProductsError) throw new Error("Failed to list products");

  const ensureProductForApp = async (
    targetApp: App,
    label: string,
    productIdentifier: string,
    displayName: string,
    duration: Duration,
    isTestStore: boolean
  ): Promise<Product> => {
    const existingProduct = existingProducts.items?.find(
      (p) => p.store_identifier === productIdentifier && p.app_id === targetApp.id
    );

    if (existingProduct) {
      console.log(label + " product already exists:", existingProduct.id);
      return existingProduct;
    }

    const body: CreateProductData["body"] = {
      store_identifier: productIdentifier,
      app_id: targetApp.id,
      type: "subscription",
      display_name: displayName,
    };

    if (isTestStore) {
      body.subscription = { duration };
      body.title = displayName;
    }

    const { data: createdProduct, error } = await createProduct({
      client,
      path: { project_id: project.id },
      body,
    });

    if (error) throw new Error("Failed to create " + label + " product");
    console.log("Created " + label + " product:", createdProduct.id);
    return createdProduct;
  };

  // Monthly products
  const testMonthly = await ensureProductForApp(testStoreApp, "Test/Monthly", MONTHLY_IDENTIFIER, MONTHLY_DISPLAY_NAME, MONTHLY_DURATION, true);
  const appMonthly = await ensureProductForApp(appStoreApp, "AppStore/Monthly", MONTHLY_IDENTIFIER, MONTHLY_DISPLAY_NAME, MONTHLY_DURATION, false);
  const playMonthly = await ensureProductForApp(playStoreApp, "PlayStore/Monthly", MONTHLY_PLAY_STORE_IDENTIFIER, MONTHLY_DISPLAY_NAME, MONTHLY_DURATION, false);

  // Annual products
  const testAnnual = await ensureProductForApp(testStoreApp, "Test/Annual", ANNUAL_IDENTIFIER, ANNUAL_DISPLAY_NAME, ANNUAL_DURATION, true);
  const appAnnual = await ensureProductForApp(appStoreApp, "AppStore/Annual", ANNUAL_IDENTIFIER, ANNUAL_DISPLAY_NAME, ANNUAL_DURATION, false);
  const playAnnual = await ensureProductForApp(playStoreApp, "PlayStore/Annual", ANNUAL_PLAY_STORE_IDENTIFIER, ANNUAL_DISPLAY_NAME, ANNUAL_DURATION, false);

  // ── Prices ────────────────────────────────────────────────────────────────
  const addPrices = async (productId: string, prices: { amount_micros: number; currency: string }[], label: string) => {
    const { error } = await client.post<TestStorePricesResponse>({
      url: "/projects/{project_id}/products/{product_id}/test_store_prices",
      path: { project_id: project.id, product_id: productId },
      body: { prices },
    });
    if (error) {
      if (error && typeof error === "object" && "type" in error && error["type"] === "resource_already_exists") {
        console.log(label + " prices already exist");
      } else {
        throw new Error("Failed to add " + label + " prices: " + JSON.stringify(error));
      }
    } else {
      console.log("Added " + label + " prices");
    }
  };

  await addPrices(testMonthly.id, MONTHLY_PRICES, "Monthly");
  await addPrices(testAnnual.id, ANNUAL_PRICES, "Annual");

  // ── Entitlement ───────────────────────────────────────────────────────────
  let entitlement: Entitlement | undefined;
  const { data: existingEntitlements, error: listEntitlementsError } = await listEntitlements({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listEntitlementsError) throw new Error("Failed to list entitlements");

  const existingEntitlement = existingEntitlements.items?.find(
    (e) => e.lookup_key === ENTITLEMENT_IDENTIFIER
  );
  if (existingEntitlement) {
    console.log("Entitlement already exists:", existingEntitlement.id);
    entitlement = existingEntitlement;
  } else {
    const { data: newEntitlement, error } = await createEntitlement({
      client,
      path: { project_id: project.id },
      body: { lookup_key: ENTITLEMENT_IDENTIFIER, display_name: ENTITLEMENT_DISPLAY_NAME },
    });
    if (error) throw new Error("Failed to create entitlement");
    console.log("Created entitlement:", newEntitlement.id);
    entitlement = newEntitlement;
  }

  const { error: attachEntitlementError } = await attachProductsToEntitlement({
    client,
    path: { project_id: project.id, entitlement_id: entitlement.id },
    body: {
      product_ids: [testMonthly.id, appMonthly.id, playMonthly.id, testAnnual.id, appAnnual.id, playAnnual.id],
    },
  });
  if (attachEntitlementError) {
    if (attachEntitlementError.type === "unprocessable_entity_error") {
      console.log("Products already attached to entitlement");
    } else {
      throw new Error("Failed to attach products to entitlement");
    }
  } else {
    console.log("Attached products to entitlement");
  }

  // ── Offering ──────────────────────────────────────────────────────────────
  let offering: Offering | undefined;
  const { data: existingOfferings, error: listOfferingsError } = await listOfferings({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  if (listOfferingsError) throw new Error("Failed to list offerings");

  const existingOffering = existingOfferings.items?.find(
    (o) => o.lookup_key === OFFERING_IDENTIFIER
  );
  if (existingOffering) {
    console.log("Offering already exists:", existingOffering.id);
    offering = existingOffering;
  } else {
    const { data: newOffering, error } = await createOffering({
      client,
      path: { project_id: project.id },
      body: { lookup_key: OFFERING_IDENTIFIER, display_name: OFFERING_DISPLAY_NAME },
    });
    if (error) throw new Error("Failed to create offering");
    console.log("Created offering:", newOffering.id);
    offering = newOffering;
  }

  if (!offering.is_current) {
    const { error } = await updateOffering({
      client,
      path: { project_id: project.id, offering_id: offering.id },
      body: { is_current: true },
    });
    if (error) throw new Error("Failed to set offering as current");
    console.log("Set offering as current");
  }

  // ── Packages ──────────────────────────────────────────────────────────────
  const { data: existingPackages, error: listPackagesError } = await listPackages({
    client,
    path: { project_id: project.id, offering_id: offering.id },
    query: { limit: 20 },
  });
  if (listPackagesError) throw new Error("Failed to list packages");

  const ensurePackage = async (lookupKey: string, displayName: string): Promise<Package> => {
    const existing = existingPackages.items?.find((p) => p.lookup_key === lookupKey);
    if (existing) {
      console.log("Package already exists:", existing.id, lookupKey);
      return existing;
    }
    const { data: newPkg, error } = await createPackages({
      client,
      path: { project_id: project.id, offering_id: offering!.id },
      body: { lookup_key: lookupKey, display_name: displayName },
    });
    if (error) throw new Error("Failed to create package: " + lookupKey);
    console.log("Created package:", newPkg.id, lookupKey);
    return newPkg;
  };

  const monthlyPkg = await ensurePackage("$rc_monthly", "Monthly Subscription");
  const annualPkg = await ensurePackage("$rc_annual", "Annual Subscription");

  const attachPackage = async (pkg: Package, products: { id: string }[], label: string) => {
    const { error } = await attachProductsToPackage({
      client,
      path: { project_id: project.id, package_id: pkg.id },
      body: {
        products: products.map((p) => ({ product_id: p.id, eligibility_criteria: "all" })),
      },
    });
    if (error) {
      if (error.type === "unprocessable_entity_error") {
        console.log("Skipping " + label + " attach: already attached or incompatible");
      } else {
        throw new Error("Failed to attach products to " + label + " package");
      }
    } else {
      console.log("Attached products to " + label + " package");
    }
  };

  await attachPackage(monthlyPkg, [testMonthly, appMonthly, playMonthly], "monthly");
  await attachPackage(annualPkg, [testAnnual, appAnnual, playAnnual], "annual");

  // ── API Keys ──────────────────────────────────────────────────────────────
  const { data: testKeys, error: testKeysError } = await listAppPublicApiKeys({
    client,
    path: { project_id: project.id, app_id: testStoreApp.id },
  });
  if (testKeysError) throw new Error("Failed to list test store API keys");

  const { data: appStoreKeys, error: appStoreKeysError } = await listAppPublicApiKeys({
    client,
    path: { project_id: project.id, app_id: appStoreApp.id },
  });
  if (appStoreKeysError) throw new Error("Failed to list App Store API keys");

  const { data: playStoreKeys, error: playStoreKeysError } = await listAppPublicApiKeys({
    client,
    path: { project_id: project.id, app_id: playStoreApp.id },
  });
  if (playStoreKeysError) throw new Error("Failed to list Play Store API keys");

  console.log("\n====================");
  console.log("RevenueCat setup complete!");
  console.log("Project ID:", project.id);
  console.log("Test Store App ID:", testStoreApp.id);
  console.log("App Store App ID:", appStoreApp.id);
  console.log("Play Store App ID:", playStoreApp.id);
  console.log("Entitlement:", ENTITLEMENT_IDENTIFIER);
  console.log("EXPO_PUBLIC_REVENUECAT_TEST_API_KEY:", testKeys?.items.map((k) => k.key).join(", ") ?? "N/A");
  console.log("EXPO_PUBLIC_REVENUECAT_IOS_API_KEY:", appStoreKeys?.items.map((k) => k.key).join(", ") ?? "N/A");
  console.log("EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY:", playStoreKeys?.items.map((k) => k.key).join(", ") ?? "N/A");
  console.log("====================\n");
}

seedRevenueCat().catch(console.error);
