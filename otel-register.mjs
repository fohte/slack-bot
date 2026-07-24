// Node's ESM loader bypasses `require()`, so `@opentelemetry/instrumentation`'s
// module-patching (used by instrumentation-http and friends to create spans
// for built-in modules like `http`) never runs against `import`ed modules
// unless this loader hook is registered before the app itself loads — without
// it, `http.Server` is never patched and no server-side spans are created.
// https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md
import { register } from 'node:module'

// `import.meta.url`, not a cwd-derived URL: `register()` resolves the bare
// specifier against this parentURL synchronously and throws if it can't, so
// the resolution must stay anchored to this file regardless of the process's
// working directory at startup.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)
