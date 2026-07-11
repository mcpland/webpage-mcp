import globals from "globals";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Global ignores first - these apply to all configurations
  {
    ignores: [
      "node_modules/",
      "dist/",
      ".output/",
      ".wxt/",
      "**/.wxt/**",
      "logs/",
      "*.log",
      ".cache/",
      ".temp/",
      ".idea/",
      ".DS_Store",
      "Thumbs.db",
      "*.zip",
      "*.tar.gz",
      "stats.html",
      "stats-*.json",
      "pnpm-lock.yaml",
      "**/workers/**",
      "app/**/workers/**",
      "packages/**/workers/**",
      "test-inject-script.js",
      "app/chrome-extension/libs/**",
      "app/chrome-extension/public/libs/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Global rule adjustments
  {
    // Allow intentionally empty catch blocks (common in extension code),
    // while keeping other empty blocks reported.
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: [
      "app/**/*.{js,mjs,cjs,jsx,ts,tsx}",
      "packages/**/*.{js,mjs,cjs,jsx,ts,tsx}",
    ],
    ignores: ["**/workers/**"], // Additional ignores for this specific config
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
      parser: tseslint.parser,
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },

    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // lint-staged runs from the repository root, so it resolves this root
    // configuration instead of the extension's package-local config. Keep the
    // extension's browser/WebExtension globals and empty-block policy aligned
    // here so staged injected scripts are checked by the same rules as
    // `pnpm --filter webpage-mcp-connector lint`.
    files: ["app/chrome-extension/**/*.{js,mjs,cjs,jsx,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      "no-empty": "off",
    },
  },
  eslintConfigPrettier,
);
