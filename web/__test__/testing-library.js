// Target of the `testing-library` alias in vite.config.ts. Re-exports
// @testing-library/react so component tests have a single import point that
// can later grow app-specific wrappers (router, providers) without touching
// every test file.
export * from "@testing-library/react";
