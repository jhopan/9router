import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Ours: Next build output (gitignored in .gitignore). `**/` because the CLI
    // launcher keeps a nested copy at cli/app/.next-cli-build/. Without this,
    // `npx eslint .` lints generated chunks and reports react/display-name
    // errors that have nothing to do with our source.
    "**/.next-cli-build/**",
    "**/.next/**",
    "cli/.build-home/**",
  ]),
]);

export default eslintConfig;
