import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts', 'src/db/migrate.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  // Bundle first-party code; keep node_modules external so production deps are
  // installed via pnpm and not duplicated into the image.
  bundle: true,
  skipNodeModulesBundle: true,
  // skipNodeModulesBundle externalizes any non-relative specifier by default,
  // which would otherwise externalize "#*" subpath imports (they don't start
  // with "./" or "../") instead of bundling the first-party source they point to.
  noExternal: [/^#/],
})
