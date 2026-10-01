const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Exclude Replit-internal directories from Metro's FallbackWatcher.
// Without this, Metro tries to watch ephemeral paths under
// .local/state/workflow-logs/ that disappear between restarts → ENOENT crash.
const existing = config.resolver.blockList || [];
const existingList = Array.isArray(existing) ? existing : [existing];
config.resolver.blockList = [...existingList, /\.local[\\/].*/];

// E2E web builds only (E2E=1 at bundle time): swap the RevenueCat SDK for a
// test double so Playwright never reaches api.revenuecat.com or a real
// account. Unset in every other build, so nothing here changes production.
if (process.env.E2E === "1") {
  const path = require("path");
  const mock = path.resolve(__dirname, "e2e/mocks/react-native-purchases.ts");
  const upstream = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === "react-native-purchases") {
      return { type: "sourceFile", filePath: mock };
    }
    return upstream
      ? upstream(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;
