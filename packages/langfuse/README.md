# `@workspace/langfuse`

The Langfuse OpenTelemetry adapter for agent runs: init, per-run callbacks,
shutdown.

```ts
import {
  initializeLangfuse,
  createLangfuseCallback,
  shutdownLangfuse,
} from "@workspace/langfuse"
```

## Where this sits

This is composition-root observability, not part of the agent runtime. It is
deliberately **not** a dependency of `@workspace/agents-core` and does not
depend on it — the runtime stays free of `@langfuse/*` and `@opentelemetry/*`,
and every entry point decides for itself whether runs are traced.

```
apps/dashboard          instrumentation-node.ts → initializeLangfuse
packages/agents         evals/run.ts → initialize + shutdown around one eval run
        ↓
@workspace/langfuse     this package
```

The link to LangChain is one type: `CallbackHandler` from `@langfuse/langchain`,
which any LangChain or LangGraph caller accepts in `config.callbacks`.

## The three functions

`initializeLangfuse({ exportMode })` builds one `NodeTracerProvider` for the
runtime and registers it. Registering is what supplies Node's async context
manager, which is what keeps tool and model spans nested below the active
workflow while a stream is consumed. Call it once, as early as the runtime
allows. `"batched"` suits a long-lived process; `"immediate"` suits one that can
be frozen mid-flush.

`createLangfuseCallback(options)` returns a fresh handler for **one** LangChain
run. Handlers retain run state, so sharing one across concurrent requests would
mix their traces.

`shutdownLangfuse()` delivers queued spans before a short-lived runtime exits.

## No keys, no tracing

Every function is a no-op unless both `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY` are set and non-empty: `initializeLangfuse` returns
`false` and `createLangfuseCallback` returns `undefined`. Nothing throws and
nothing has to be conditionally wired at the call site.

The remaining configuration is read by the Langfuse SDK itself, not by this
package — `LANGFUSE_BASE_URL` and `LANGFUSE_TRACING_ENVIRONMENT`. See the root
`README.md` for the full set.

## Development

```bash
pnpm turbo build --filter=@workspace/langfuse
pnpm turbo typecheck --filter=@workspace/langfuse
```

Use `pnpm turbo dev --filter=@workspace/langfuse` (`tsc --build --watch`) while
editing alongside a consumer.
