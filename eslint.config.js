import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/* Flat config for the whole repo: the Node runtime (src/), its node:test suite
 * (test/) and the React viewer (viewer-ui/src). The runtime is ESM TypeScript
 * under NodeNext; the viewer adds JSX. `dist/` build output is ignored.
 *
 * House style notes encoded here:
 *  - `allowEmptyCatch`: the codebase deliberately swallows errors at
 *    best-effort boundaries (log flush, cleanup, viewer probes) with a comment
 *    saying why — `no-empty` would flag every one of them.
 *  - `args: "none"` on no-unused-vars: several signatures keep parameters for
 *    interface symmetry / future use, documented at the definition.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "viewer-ui/dist/**", "tools/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      "@typescript-eslint/no-explicit-any": "off",
      "max-lines": ["error", { max: 1500 }],
    },
  },
  {
    files: ["viewer-ui/src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      "@typescript-eslint/no-explicit-any": "off",
      "max-lines": ["error", { max: 1500 }],
    },
  }
);
