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
  updateApp,
  detachProductsFromPackage,
  detachProductsFromEntitlement,
  deletePackageFromOffering,
  deleteProduct,
  type App,
  type Product,
  type Project,
  type Entitlement,
  type Offering,
  type Package,
  type CreateProductData,
  type Duration,
} from "@replit/revenuecat-sdk";

const PROJECT_NAME = "ScrollStitch";

// Weekly product — the primary plan the trial funnels into
const WEEKLY_IDENTIFIER = "scrollstitch_pro_weekly";
const WEEKLY_PLAY_STORE_IDENTIFIER = "scrollstitch_pro_weekly:weekly";
const WEEKLY_DISPLAY_NAME = "ScrollStitch Pro Weekly";
const WEEKLY_DURATION = "P1W" as const;

// Annual product
const ANNUAL_IDENTIFIER = "scrollstitch_pro_annual";
const ANNUAL_PLAY_STORE_IDENTIFIER = "scrollstitch_pro_annual:annual";
const ANNUAL_DISPLAY_NAME = "ScrollStitch Pro Annual";
const ANNUAL_DURATION = "P1Y" as const;

const APP_STORE_APP_NAME = "ScrollStitch iOS";
const APP_STORE_BUNDLE_ID = "com.scrollstitch";
const PLAY_STORE_APP_NAME = "ScrollStitch Android";
const PLAY_STORE_PACKAGE_NAME = "com.scrollstitch";

const ENTITLEMENT_IDENTIFIER = "pro";
const ENTITLEMENT_DISPLAY_NAME = "Pro Access";

const OFFERING_IDENTIFIER = "default";
const OFFERING_DISPLAY_NAME = "Default Offering";

// Weekly: $4.99 | Annual: $29.99
const WEEKLY_PRICES = [{ amount_micros: 4990000, currency: "USD" }];
const ANNUAL_PRICES = [{ amount_micros: 29990000, currency: "USD" }];

type TestStorePricesResponse = {
  object: string;
  prices: { amount_micros: number; currency: string }[];
};

async function seedRevenueCat() {
  const client = await getUncachableRevenueCatClient();

  // ── Project ──────────────────────────────────────────────────────────────
  // Match on REVENUECAT_PROJECT_ID first and only fall back to the name. The
  // name is cosmetic and can be changed in the dashboard; matching on it alone
  // means a rename here silently creates a SECOND project, orphaning the apps
  // and API keys the app is already shipping with.
  let project: Project;
  const { data: existingProjects, error: listProjectsError } = await listProjects({
    client,
    query: { limit: 20 },
  });
  if (listProjectsError) throw new Error("Failed to list projects");

  const configuredProjectId = process.env.REVENUECAT_PROJECT_ID;
  const existingProject =
    (configuredProjectId
      ? existingProjects.items?.find((p) => p.id === configuredProjectId)
      : undefined) ?? existingProjects.items?.find((p) => p.name === PROJECT_NAME);

  if (configuredProjectId && !existingProject) {
    throw new Error(
      `REVENUECAT_PROJECT_ID is set to ${configuredProjectId} but no such project was found. ` +
        `Clear the variable to create a new project, or fix the ID.`
    );
  }

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
    // The app predates the rename, and its bundle id was still the scaffold's
    // placeholder. A bundle id that disagrees with app.json means the store
    // cannot resolve a single product, so this is not cosmetic.
    const { error: updateError } = await updateApp({
      client,
      path: { project_id: project.id, app_id: appStoreApp.id },
      body: { name: APP_STORE_APP_NAME, app_store: { bundle_id: APP_STORE_BUNDLE_ID } },
    });
    if (updateError) {
      throw new Error(
        `Failed to update the App Store app to ${APP_STORE_BUNDLE_ID}: ` +
          JSON.stringify(updateError)
      );
    }
    console.log(`Updated App Store app -> ${APP_STORE_APP_NAME} / ${APP_STORE_BUNDLE_ID}`);
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
    const { error: updateError } = await updateApp({
      client,
      path: { project_id: project.id, app_id: playStoreApp.id },
      body: {
        name: PLAY_STORE_APP_NAME,
        play_store: { package_name: PLAY_STORE_PACKAGE_NAME },
      },
    });
    if (updateError) {
      throw new Error(
        `Failed to update the Play Store app to ${PLAY_STORE_PACKAGE_NAME}: ` +
          JSON.stringify(updateError)
      );
    }
    console.log(`Updated Play Store app -> ${PLAY_STORE_APP_NAME} / ${PLAY_STORE_PACKAGE_NAME}`);
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

  // Weekly products
  const testWeekly = await ensureProductForApp(testStoreApp, "Test/Weekly", WEEKLY_IDENTIFIER, WEEKLY_DISPLAY_NAME, WEEKLY_DURATION, true);
  const appWeekly = await ensureProductForApp(appStoreApp, "AppStore/Weekly", WEEKLY_IDENTIFIER, WEEKLY_DISPLAY_NAME, WEEKLY_DURATION, false);
  const playWeekly = await ensureProductForApp(playStoreApp, "PlayStore/Weekly", WEEKLY_PLAY_STORE_IDENTIFIER, WEEKLY_DISPLAY_NAME, WEEKLY_DURATION, false);

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

  await addPrices(testWeekly.id, WEEKLY_PRICES, "Weekly");
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
      product_ids: [testWeekly.id, appWeekly.id, playWeekly.id, testAnnual.id, appAnnual.id, playAnnual.id],
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

  const weeklyPkg = await ensurePackage("$rc_weekly", "Weekly Subscription");
  const annualPkg = await ensurePackage("$rc_annual", "Annual Subscription");

  /** The products currently attached to a package, as ids. */
  const attachedProductIds = async (packageId: string): Promise<string[]> => {
    const { data, error } = await listPackages({
      client,
      path: { project_id: project.id, offering_id: offering!.id },
      query: { limit: 50, expand: ["items.product"] },
    });
    if (error) throw new Error("Could not read package attachments");
    const stored = data.items?.find((p) => p.id === packageId);
    return (stored?.products?.items ?? [])
      .map((a) => (a as { product?: { id?: string } }).product?.id)
      .filter((id): id is string => Boolean(id));
  };

  /**
   * Make a package hold exactly the given products.
   *
   * RevenueCat allows one product per app in a package, so a leftover from the
   * previous naming does not sit harmlessly beside the new one — it *blocks*
   * it, and the attach comes back as unprocessable_entity. Clearing first is
   * what makes this converge rather than depend on what was there before.
   */
  const attachPackage = async (pkg: Package, products: { id: string }[], label: string) => {
    const desired = new Set(products.map((p) => p.id));

    const existing = await attachedProductIds(pkg.id);
    const conflicting = existing.filter((id) => !desired.has(id));
    if (conflicting.length > 0) {
      const { error } = await detachProductsFromPackage({
        client,
        path: { project_id: project.id, package_id: pkg.id },
        body: { product_ids: conflicting },
      });
      if (error) {
        throw new Error(
          `Could not clear ${conflicting.length} superseded product(s) from the ` +
            `${label} package: ${JSON.stringify(error)}`
        );
      }
      console.log(`Cleared ${conflicting.length} superseded product(s) from ${label} package`);
    }

    const missing = products.filter((p) => !existing.includes(p.id));
    if (missing.length > 0) {
      const { error } = await attachProductsToPackage({
        client,
        path: { project_id: project.id, package_id: pkg.id },
        body: {
          products: missing.map((p) => ({ product_id: p.id, eligibility_criteria: "all" })),
        },
      });
      if (error) {
        throw new Error(
          `Failed to attach products to the ${label} package: ${JSON.stringify(error)}`
        );
      }
      console.log(`Attached ${missing.length} product(s) to ${label} package`);
    }

    // Verify the products that should be there actually are. Counting is not
    // enough: the previous run counted three and passed, but they were the old
    // products, which the cleanup then removed — leaving the package empty and
    // the plan priceless in the app.
    const finalIds = await attachedProductIds(pkg.id);
    const absent = products.filter((p) => !finalIds.includes(p.id));
    if (absent.length > 0) {
      throw new Error(
        `The ${label} package is missing ${absent.length} of its ${products.length} ` +
          `products after attaching. RevenueCat omits a package it cannot resolve, ` +
          `so the app would show no price for that plan.`
      );
    }
    console.log(`Verified ${label} package: ${finalIds.length} product(s) attached`);
  };

  await attachPackage(weeklyPkg, [testWeekly, appWeekly, playWeekly], "weekly");
  await attachPackage(annualPkg, [testAnnual, appAnnual, playAnnual], "annual");

  // ── Retire the previous naming ────────────────────────────────────────────
  // The project was set up before the rename and before the plan changed from
  // monthly to weekly, so it still carries scrollsnap_* products and an
  // $rc_monthly package the app never asks for. Store identifiers cannot be
  // edited — RevenueCat only lets a product's display name change — so the old
  // products have to be detached and removed rather than renamed.
  //
  // Deliberately narrow: only products whose identifier carries the old name
  // are touched, and only after they have been detached from everything.
  const LEGACY_IDENTIFIER = /scrollsnap/i;
  const keepPackages = new Set(["$rc_weekly", "$rc_annual"]);

  const { data: allPackages, error: allPackagesError } = await listPackages({
    client,
    path: { project_id: project.id, offering_id: offering.id },
    query: { limit: 50, expand: ["items.product"] },
  });
  if (allPackagesError) throw new Error("Failed to list packages for cleanup");

  // Only whole packages are removed here. Detaching superseded products is
  // attachPackage's job and has already happened — doing it again after the
  // fact is what emptied $rc_annual on the previous run.
  for (const pkg of allPackages.items ?? []) {
    if (keepPackages.has(pkg.lookup_key)) continue;
    // A package the app does not look for. Leaving it costs nothing at runtime
    // but keeps a dead plan visible in the dashboard.
    const { error } = await deletePackageFromOffering({
      client,
      path: { project_id: project.id, package_id: pkg.id },
    });
    if (error) {
      console.warn(`Could not remove stale package ${pkg.lookup_key}:`, error);
    } else {
      console.log(`Removed stale package ${pkg.lookup_key}`);
    }
  }

  const { data: productsNow, error: productsNowError } = await listProducts({
    client,
    path: { project_id: project.id },
    query: { limit: 100 },
  });
  if (productsNowError) throw new Error("Failed to list products for cleanup");

  const legacyProducts = (productsNow.items ?? []).filter((p) =>
    LEGACY_IDENTIFIER.test(p.store_identifier ?? "")
  );

  if (legacyProducts.length > 0) {
    const legacyIds = legacyProducts.map((p) => p.id);
    const { error: detachError } = await detachProductsFromEntitlement({
      client,
      path: { project_id: project.id, entitlement_id: entitlement.id },
      body: { product_ids: legacyIds },
    });
    if (detachError) {
      console.warn("Could not detach old products from the entitlement:", detachError);
    }

    for (const p of legacyProducts) {
      const { error } = await deleteProduct({
        client,
        path: { project_id: project.id, product_id: p.id },
      });
      if (error) {
        // A product with recorded transactions cannot be deleted — test
        // purchases are enough to earn that. Harmless: it has already been
        // detached from every package and from the entitlement, so it is
        // invisible to the app and only lingers in the dashboard list.
        console.warn(
          `Kept ${p.store_identifier} (detached but not deletable): ` +
            `${(error as { message?: string }).message ?? JSON.stringify(error)}`
        );
      } else {
        console.log(`Deleted old product ${p.store_identifier}`);
      }
    }
  }

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
