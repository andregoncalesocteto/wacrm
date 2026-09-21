import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
  ]),
  // i18n: flag hardcoded text in JSX (ADR-001). Warn only; promote to error at zero warnings.
  {
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "warn",
        { noStrings: false, allowedStrings: ["·", "/", "—", "•"] },
      ],
    },
  },
  // i18n: formatting goes through next-intl's useFormatter()/getFormatter() (ADR-002), so the
  // locale and time zone come from one place. Direct toLocale*String() and Intl.*Format are errors.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].map((property) => ({
          property,
          message:
            "Do not call toLocale*String() directly: use useFormatter() from next-intl (or the locale-aware helpers in src/lib/currency.ts) so the app locale and time zone apply.",
        })),
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "NewExpression[callee.object.name='Intl'][callee.property.name=/^(DateTimeFormat|NumberFormat)$/]",
          message:
            "Do not instantiate Intl.DateTimeFormat/Intl.NumberFormat directly: use useFormatter() from next-intl so the app locale and time zone apply.",
        },
      ],
    },
  },
  // Exceptions to the rule above: files that must call Intl with an explicit locale/time zone.
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      // Low-level helpers that receive the locale as an argument (callers pass the active one);
      // they are the single place that turns a locale into an Intl formatter.
      "src/lib/currency.ts",
      "src/lib/automations/trigger-meta.ts",
      // Only probes whether a time zone is valid for Intl (`new Intl.DateTimeFormat('en', { timeZone })`
      // throws on invalid IANA names); it never formats user-facing values.
      "src/lib/i18n/browser-time-zone.ts",
    ],
    rules: {
      "no-restricted-properties": "off",
      "no-restricted-syntax": "off",
    },
  },
]);

export default eslintConfig;
