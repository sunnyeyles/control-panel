# `@workspace/agent-tools`

The shared tool catalog. One tool per module, so a project can import exactly
the tools it needs.

```ts
import { getCurrentTime } from "@workspace/agent-tools/time"
```

Or take the lot, when a general-purpose agent genuinely wants everything:

```ts
import { allTools } from "@workspace/agent-tools"
```

Prefer the per-tool imports. A model picks worse as the tool list grows, so an
agent should carry the tools its job needs and nothing more — `allTools` is a
convenience for the general assistant, not a default.

## Why this is its own package

These are plain LangChain tools (`StructuredToolInterface`). They know nothing
about LangGraph, this repo's graph, or `@workspace/agents-core` — you can hand
them to any LangChain agent, or call `.invoke()` on one directly. Keeping them
out of the runtime package means a project can take the runtime and supply its
own tools, and that a tool reaching for a heavy dependency does not drag that
dependency into every consumer of the runtime.

## Adding a tool

Create `src/<name>.ts` exporting one tool, then re-export it from `src/index.ts`
and add it to `allTools`. The subpath export is a wildcard — `./*` maps to
`./dist/*.js` — so `@workspace/agent-tools/<name>` works with no config change.

```ts
// src/weather.ts
import { tool } from "@langchain/core/tools"
import * as z from "zod"

export const getWeather = tool(async ({ city }: { city: string }) => "...", {
  name: "get_weather",
  description:
    "Look up the current weather in a city. Call this before answering anything about conditions outside.",
  schema: z.object({ city: z.string().describe("City name, e.g. Sydney.") }),
})
```

Two things that matter more than they look:

- **Write the description for the model, not for a human**, and say _when_ to
  call the tool rather than only what it does. That measurably raises the
  should-call rate.
- **Names must be unique across any agent's tool set.** `createToolRegistry` in
  `@workspace/agents-core` throws on a duplicate rather than letting one tool
  silently shadow another, so a collision surfaces at construction time.

A tool that needs data access should take its dependency explicitly — add it to
this package's `dependencies` and import it in that tool's module only.

## Tools bound to a run

Not every tool can be a module singleton. The board searches and
`get_posting_details` share a `PostingCatalog` — one search writes into it and
the other reads out of it, so the pair only makes sense per run — and each is
exported as a `createXSearch(catalog)` factory rather than a ready-made tool. A
module-level instance would carry one run's postings into the next, and on a warm
Lambda container that is not hypothetical.

`posting-catalog.ts` states the shape and takes the id function from its caller.
It does not know how a posting id is derived, deliberately: the platform already
has exactly one answer (`postingId` in `@workspace/agents`), and this package
must not depend on that one — a second hash of a URL down here would be a second
identity for the same advertisement.

## Build

Consumed as built output (`dist/`). Turbo's `build.dependsOn: ["^build"]` orders
this ahead of anything that imports it.

```bash
pnpm turbo build --filter=@workspace/agent-tools
pnpm turbo dev --filter=@workspace/agent-tools   # tsc --build --watch
```
