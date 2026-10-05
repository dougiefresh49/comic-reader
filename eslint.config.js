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
  // both entries cover gets both selector lists, and each module file keeps
  // the other entry's list.
  {
    // issues has PK (book_id, id): query it only through src/lib/issue-queries.ts (#150).
    // castlist: every read and write lives in src/lib/cast.ts (#429).
    ignores: ["src/lib/issue-queries.ts", "src/lib/cast.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...issuesFrom, ...castlistFrom],
    },
  },
  {
    files: ["src/lib/cast.ts"],
    rules: { "no-restricted-syntax": ["error", ...issuesFrom] },
  },
  {
    files: ["src/lib/issue-queries.ts"],
    rules: { "no-restricted-syntax": ["error", ...castlistFrom] },
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
