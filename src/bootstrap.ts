// Must run before any instrumented module is imported, otherwise
// @opentelemetry/auto-instrumentations-node cannot patch them — import
// `#bootstrap` first from the Node entrypoint.
// This alone is not enough for built-in modules like `http`, though — the
// `--import @fohte/service-kit/otel-register` flag on the start/dev scripts
// must preload it before this file (or anything else) is imported, or
// `http.Server` is never patched.
import { initObservabilityIfConfigured } from '@fohte/service-kit/observability'

initObservabilityIfConfigured(process.env, {
  extraStringTruncators: [
    { pattern: /^(slack_)?message(_text|_body)?$/i, maxLength: 200 },
  ],
})
