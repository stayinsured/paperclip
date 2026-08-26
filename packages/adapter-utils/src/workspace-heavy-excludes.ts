/**
 * Reproducible dependency and build trees that must not cross a managed
 * workspace transport boundary. A run can recreate these from source and lock
 * files; copying them multiplies disk use per run and can exhaust the remote
 * runtime before useful work starts.
 */
export const WORKSPACE_HEAVY_DIR_NAMES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".pnpm-store",
  ".npm-cache",
  ".vite",
] as const;

export const WORKSPACE_HEAVY_DIR_EXCLUDES = WORKSPACE_HEAVY_DIR_NAMES.flatMap((entry) => [
  entry,
  `${entry}/*`,
  `*/${entry}`,
  `*/${entry}/*`,
]);
