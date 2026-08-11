/**
 * Print the live RevenueCat configuration. Read-only — it creates, updates and
 * deletes nothing.
 *
 * Two things this answers that nothing else does:
 *
 *   - Which identifiers are actually in use. Store product identifiers are
 *     permanent once the subscription exists in App Store Connect or Play, so
 *     knowing what is already out there decides whether a rename is a rename or
 *     a rebuild.
 *   - Why a plan has no price in the app. RevenueCat omits a package from the
 *     offering when it cannot resolve a product behind it, and the app can only
 *     see the result, not the cause. The package listing below shows it
 *     directly.
 *
 * Run inside the Replit workspace, where the RevenueCat connector lives:
 *   npx tsx scripts/inspectRevenueCat.ts
 */
import { getUncachableRevenueCatClient } from "./revenueCatClient";
import {
  listProjects,
  listApps,
  listProducts,
  listEntitlements,
  listOfferings,
  listPackages,
} from "@replit/revenuecat-sdk";

const OLD_NAME = /scrollsnap/i;

async function main() {
  const client = await getUncachableRevenueCatClient();

  const { data: projects, error: projectsError } = await listProjects({
    client,
    query: { limit: 20 },
  });
  if (projectsError) throw new Error("Failed to list projects");

  const configuredId = process.env.REVENUECAT_PROJECT_ID;
  console.log(`REVENUECAT_PROJECT_ID = ${configuredId ?? "(unset)"}\n`);
  console.log("── Projects ──");
  for (const p of projects.items ?? []) {
    const marker = p.id === configuredId ? "  <- configured" : "";
    console.log(`  ${p.id}  ${p.name}${marker}`);
  }

  const project =
    (configuredId ? projects.items?.find((p) => p.id === configuredId) : undefined) ??
    projects.items?.[0];
  if (!project) throw new Error("No project to inspect");
  console.log(`\nInspecting: ${project.name} (${project.id})\n`);

  const { data: apps } = await listApps({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  console.log("── Apps ──");
  const appNames = new Map<string, string>();
  for (const a of apps?.items ?? []) {
    appNames.set(a.id, a.name);
    const store =
      a.type === "app_store"
        ? `bundle ${(a as { app_store?: { bundle_id?: string } }).app_store?.bundle_id ?? "?"}`
        : a.type === "play_store"
          ? `package ${(a as { play_store?: { package_name?: string } }).play_store?.package_name ?? "?"}`
          : "test store";
    console.log(`  ${a.type.padEnd(11)} ${a.name.padEnd(26)} ${store}`);
  }

  const { data: products } = await listProducts({
    client,
    path: { project_id: project.id },
    query: { limit: 100 },
  });
  console.log("\n── Products ──");
  console.log("  (store_identifier is the permanent one — it must match the store)");
  for (const p of products?.items ?? []) {
    const flag = OLD_NAME.test(p.store_identifier ?? "") ? "  << OLD NAME" : "";
    console.log(
      `  ${(p.store_identifier ?? "?").padEnd(34)} ${(p.display_name ?? "").padEnd(26)} ` +
        `[${appNames.get(p.app_id ?? "") ?? p.app_id}]${flag}`
    );
  }

  const { data: entitlements } = await listEntitlements({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  console.log("\n── Entitlements ──");
  for (const e of entitlements?.items ?? []) {
    console.log(`  ${e.lookup_key.padEnd(16)} ${e.display_name ?? ""}`);
  }

  const { data: offerings } = await listOfferings({
    client,
    path: { project_id: project.id },
    query: { limit: 20 },
  });
  console.log("\n── Offerings & packages ──");
  for (const o of offerings?.items ?? []) {
    console.log(`  ${o.lookup_key}${o.is_current ? "  (current)" : ""}`);
    const { data: packages } = await listPackages({
      client,
      path: { project_id: project.id, offering_id: o.id },
      query: { limit: 20, expand: ["items.product"] },
    });
    for (const pkg of packages?.items ?? []) {
      const attached = pkg.products?.items ?? [];
      const label = attached.length === 0 ? "NO PRODUCTS — will not appear in the app" : "";
      console.log(`    ${pkg.lookup_key.padEnd(14)} ${attached.length} product(s)  ${label}`);
      for (const a of attached) {
        const prod = (a as { product?: { store_identifier?: string; app_id?: string } }).product;
        console.log(
          `        ${(prod?.store_identifier ?? "?").padEnd(34)} ` +
            `[${appNames.get(prod?.app_id ?? "") ?? prod?.app_id ?? "?"}]`
        );
      }
    }
  }

  const stale = (products?.items ?? []).filter((p) => OLD_NAME.test(p.store_identifier ?? ""));
  console.log("\n── Summary ──");
  console.log(`  Products carrying the old name in their identifier: ${stale.length}`);
  if (stale.length > 0) {
    console.log(
      "  Store identifiers cannot be renamed once the subscription exists in\n" +
        "  App Store Connect or Google Play. Check there before deciding."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
