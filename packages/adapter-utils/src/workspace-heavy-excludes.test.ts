import { describe, expect, it } from "vitest";
import { shouldExcludePath } from "./exclude-patterns.js";
import {
  WORKSPACE_HEAVY_DIR_EXCLUDES,
  WORKSPACE_HEAVY_DIR_NAMES,
} from "./workspace-heavy-excludes.js";

describe("workspace heavy excludes", () => {
  it("matches root and nested reproducible dependency and cache trees", () => {
    for (const name of WORKSPACE_HEAVY_DIR_NAMES) {
      expect(shouldExcludePath(name, WORKSPACE_HEAVY_DIR_EXCLUDES)).toBe(true);
      expect(
        shouldExcludePath(
          `packages/ui/${name}/generated.bin`,
          WORKSPACE_HEAVY_DIR_EXCLUDES,
        ),
      ).toBe(true);
    }
  });

  it("keeps source, lock files, and ordinary generated deliverables", () => {
    expect(shouldExcludePath("src/index.ts", WORKSPACE_HEAVY_DIR_EXCLUDES)).toBe(false);
    expect(shouldExcludePath("pnpm-lock.yaml", WORKSPACE_HEAVY_DIR_EXCLUDES)).toBe(false);
    expect(shouldExcludePath("artifacts/report.pdf", WORKSPACE_HEAVY_DIR_EXCLUDES)).toBe(false);
  });

  it("covers package-manager caches implicated in per-run disk growth", () => {
    expect(WORKSPACE_HEAVY_DIR_NAMES).toEqual(
      expect.arrayContaining([
        "node_modules",
        ".pnpm-store",
        ".npm-cache",
        ".turbo",
        ".vite",
      ]),
    );
  });
});
