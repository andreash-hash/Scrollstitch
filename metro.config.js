const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Exclude Replit-internal directories from Metro's FallbackWatcher.
// Without this, Metro tries to watch ephemeral paths under
// .local/state/workflow-logs/ that disappear between restarts → ENOENT crash.
const existing = config.resolver.blockList || [];
const existingList = Array.isArray(existing) ? existing : [existing];
config.resolver.blockList = [...existingList, /\.local[\\/].*/];

module.exports = config;
