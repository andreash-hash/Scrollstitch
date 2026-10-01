const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "dist-e2e/*", "playwright-report/*", "test-results/*", "server_dist/*"],
  }
]);
