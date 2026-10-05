import { FlatCompat } from "@eslint/eslintrc";
import tseslint from "typescript-eslint";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

/** `.from("<table>")` and `.from(`<table>`)`, for `no-restricted-syntax`. */
/** @param {string} table @param {string} message */
const restrictFrom = (table, message) => [
  {
    selector: `CallExpression[callee.property.name='from'][arguments.0.value='${table}']`,
    message,
  },
  {
    selector: `CallExpression[callee.property.name='from'][arguments.0.quasis.0.value.cooked='${table}']`,
    message,
  },
];
const issuesFrom = restrictFrom(
  "issues",
  "Query issues through src/lib/issue-queries.ts, which requires the book id.",
);
const castlistFrom = restrictFrom(
  "castlist",
  "Read and write castlist through src/lib/cast.ts, keyed on character_id.",
);
const voicesFrom = restrictFrom(
  "voices",
  "Read and write voices through src/lib/voice-slots/ or src/lib/voice-requests.ts.",
);
/** The voices module (#458). */
const voicesModule = ["src/lib/voice-slots/**", "src/lib/voice-requests.ts"];

export default tseslint.config(
  {
    ignores: [".next", "src/types/database.ts", "scripts/spine/**"],
  },
  ...compat.extends("next/core-web-vitals"),
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  // One `no-restricted-syntax` value wins per file in flat config, so a file
  // every entry covers gets every selector list, and each module file keeps
  // the other entries' lists.
  {
    // issues has PK (book_id, id): query it only through src/lib/issue-queries.ts (#150).
    // castlist: every read and write lives in src/lib/cast.ts (#429).
    // voices: every read and write lives in the voices module (#458).
    ignores: ["src/lib/issue-queries.ts", "src/lib/cast.ts", ...voicesModule],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...issuesFrom,
        ...castlistFrom,
        ...voicesFrom,
      ],
    },
  },
  {
    files: ["src/lib/cast.ts"],
    rules: { "no-restricted-syntax": ["error", ...issuesFrom, ...voicesFrom] },
  },
  {
    files: ["src/lib/issue-queries.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...castlistFrom, ...voicesFrom],
    },
  },
  {
    files: voicesModule,
    rules: {
      "no-restricted-syntax": ["error", ...issuesFrom, ...castlistFrom],
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
);
