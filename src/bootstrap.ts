// Must run before any instrumented module is imported, otherwise
// @opentelemetry/auto-instrumentations-node cannot patch them — hence
<<<<<<< before updating
// `import './bootstrap'` as the very first statement of `main.ts`.
||||||| last update
// @opentelemetry/auto-instrumentations-node cannot patch them. Either
// `import './bootstrap'` as the very first statement of the entrypoint,
// or pre-load with `node --import` (ESM) / `--require` (CJS).
=======
// `import './bootstrap'` as the very first statement of `index.ts`.
>>>>>>> after updating
// This alone is not enough for built-in modules like `http`, though — see
<<<<<<< before updating
// otel-register.mjs, registered via `--import` in the `start`/`dev` scripts
// and the Dockerfile's `CMD`, for why.
||||||| last update
// @opentelemetry/auto-instrumentations-node cannot patch them. Either
// `import './bootstrap'` as the very first statement of the entrypoint,
// or pre-load with `node --import` (ESM) / `--require` (CJS).
=======
// otel-register.mjs: it must be preloaded via `node --import` before this
// file (or anything else) is imported, or `http.Server` is never patched.
>>>>>>> after updating
import {
  initObservability,
  isObservabilityConfigured,
} from '@fohte/service-kit/observability'

if (isObservabilityConfigured(process.env)) {
  initObservability(process.env, {
    extraStringTruncators: [
      { pattern: /^(slack_)?message(_text|_body)?$/i, maxLength: 200 },
    ],
  })
}
