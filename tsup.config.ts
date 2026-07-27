import { defineConfig } from 'tsup'

export default defineConfig({
<<<<<<< before updating
  entry: ['src/main.ts', 'src/db/migrate.ts'],
||||||| last update
=======
  entry: ['src/index.ts'],
>>>>>>> after updating
  format: ['esm'],
<<<<<<< before updating
||||||| last update
=======
  // Keep in sync with the node version in .mise.toml.
>>>>>>> after updating
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
<<<<<<< before updating
  splitting: false,
  sourcemap: false,
  // Bundle first-party code; keep node_modules external so production deps are
  // installed via pnpm and not duplicated into the image.
  bundle: true,
||||||| last update
=======
  // Bundle first-party code; keep node_modules external so
  // @opentelemetry/auto-instrumentations-node's module-patching hook still
  // applies to the real package in node_modules instead of a bundled copy.
>>>>>>> after updating
  skipNodeModulesBundle: true,
<<<<<<< before updating
  // skipNodeModulesBundle externalizes any non-relative specifier by default,
  // which would otherwise externalize "#*" subpath imports (they don't start
  // with "./" or "../") instead of bundling the first-party source they point to.
  noExternal: [/^#/],
||||||| last update
=======
>>>>>>> after updating
})
