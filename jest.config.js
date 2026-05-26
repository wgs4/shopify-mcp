// Jest config for the shopify-mcp Node/TS project.
//
// The package is `"type": "module"` with `moduleResolution: NodeNext`, so
// source imports use the `.js` extension even though the files are `.ts`.
// ts-jest's default-esm preset handles this when we strip `.js` from the
// import path during resolution. See ts-jest docs: ESM Support.
import { createDefaultEsmPreset } from "ts-jest";

const presetConfig = createDefaultEsmPreset({
  // Use a relaxed test tsconfig: the main tsconfig.json excludes test files
  // (**/*.test.ts), so ts-jest needs an inline override that includes them
  // and otherwise mirrors the project options.
  tsconfig: {
    module: "ESNext",
    target: "ES2020",
    moduleResolution: "Bundler",
    esModuleInterop: true,
    skipLibCheck: true,
    strict: true,
    allowJs: false,
    isolatedModules: true,
  },
});

/** @type {import('jest').Config} */
const config = {
  ...presetConfig,
  testEnvironment: "node",
  // Match TS test files only; don't pick up compiled .js or random fixtures.
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  // Map import paths like "./foo.js" -> "./foo" so ts-jest resolves the
  // .ts source under NodeNext-style ESM imports.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  // Quiet noisy console.error from the watchdog logs during tests.
  silent: false,
};

export default config;
