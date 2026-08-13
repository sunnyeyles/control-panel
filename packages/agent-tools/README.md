# `@workspace/agent-tools`

The shared tool catalog, grouped by domain. One tool per module, so a project
can import exactly the tools it needs.

```ts
import { getCurrentTime } from "@workspace/agent-tools/time"
import { createSeekSearch } from "@workspace/agent-tools/boards/seek-search"
```

**There is no barrel and no `allTools`.** There used to be one of each, and it
had been wrong for a long time: it held two tools and called itself "every tool
in the catalog", because every tool added since is a `createX(catalog, log)`
factory bound to one run and a module-level array structurally cannot hold one.
Which tools an agent carries is the agent's decision — a model picks worse as
the tool list grows — so it is made in `@workspace/agents`, where each agent
names its own set. `ASSISTANT_TOOLS` there is the general assistant's.

## Layout

Four directories, and the split is by domain rather than by whether something is
a tool. A tool is a thin wrapper; what makes a board or a whiteboard work is the
support code beside it, and separating the two would put every feature in two
places.

| Directory     | Holds                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| `boards/`     | job-board search, the posting catalog, the by-URL fetcher, the registry |
| `whiteboard/` | the nine canvas tools, the turn's board session, layout and rendering   |
| `pages/`      | the two general page fetchers — **and never a tool**, see R9            |
| `internal/`   | the shared JSON-POST transport. Not exported; refactor it freely        |

`time.ts`, `web-search.ts` and `env.ts` sit at the root because they belong to
no domain.

**The exports map is the boundary, not a convention.** It lists `./time`,
`./web-search`, `./env` and the three directory patterns, so `internal/` and
`test-support/` cannot be imported from outside this package at all. It used to
be a bare `./*`, which published every file and made any rename of a private
helper a breaking change to a surface nobody meant to have. ESLint cannot
enforce this — `eslint-plugin-only-warn` means no rule ever fails a build — so
the package manifest does.

## Why this is its own package

These are plain LangChain tools (`StructuredToolInterface`). They know nothing
about LangGraph, this repo's graph, or `@workspace/agents-core` — you can hand
them to any LangChain agent, or call `.invoke()` on one directly. Keeping them
out of the runtime package means a project can take the runtime and supply its
own tools, and that a tool reaching for a heavy dependency does not drag that
dependency into every consumer of the runtime.

## Adding a tool

Create `src/<domain>/<name>.ts` exporting one tool. The subpath pattern for that
directory already covers it, so `@workspace/agent-tools/<domain>/<name>` works
with no config change. Then give it to the agent that needs it, in
`@workspace/agents`.

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
  should-call rate. `naming.test.ts` enforces only that there is one; whether it
  is any good is a review question.
- **Names must be unique across any agent's tool set.** `createToolRegistry` in
  `@workspace/agents-core` throws on a duplicate rather than letting one tool
  silently shadow another — but that is at agent-construction time, far from the
  edit. `naming.test.ts` builds every tool this package can produce and fails on
  a collision, or on a name that is not `snake_case`, at the edit instead.

A tool that needs data access should take its dependency explicitly — add it to
this package's `dependencies` and import it in that tool's module only. A tool
that needs an environment variable declares it in `src/env.ts`; `env.test.ts`
reads every `requireEnv` call in `src/` and fails on one that is missing.

## Adding a job board

One file under `src/boards/` and one row in `src/boards/registry.ts`.

Everything that is not about the board — the token, the run timeout, the clamp,
the split between faults that throw and faults that come back as a sentence, the
teaser bound, the rendering — is in `apify-search.ts`. What a board supplies is
an `ApifyBoardSpec`: an actor id, the request body that actor wants, which of
its fields carry the title, the company and the URL, and optionally a `byUrl`
for fetching one named advertisement.

The registry row adds the facts the platform needs on top of that — the hosts
the board answers under, the query parameters it stamps per search, and its
search factory. `postingId` in `@workspace/agents` reads the first two; nothing
else has to be told the board exists.

`spec-contract.test.ts` then covers the new board for free: unique tool name,
bounds a clamp can satisfy, `toPosting({})` surviving an empty actor item, and —
the one that matters — no search field on the by-URL body, which is how one link
becomes a crawl.

## Tools bound to a run

Not every tool can be a module singleton. The board searches and
`get_posting_details` share a `PostingCatalog` — one search writes into it and
the other reads out of it, so the pair only makes sense per run — and each is
exported as a `createXSearch(catalog)` factory rather than a ready-made tool. A
module-level instance would carry one run's postings into the next, and on a warm
Lambda container that is not hypothetical. `whiteboard/session.ts` is the same
arrangement for one turn of one board.

`boards/posting-catalog.ts` states the shape and takes the id function from its
caller. It does not know how a posting id is derived, deliberately: the platform
already has exactly one answer (`postingId` in `@workspace/agents`), and this
package must not depend on that one — a second hash of a URL down here would be
a second identity for the same advertisement.

## Build

Consumed as built output (`dist/`). Turbo's `build.dependsOn: ["^build"]` orders
this ahead of anything that imports it.

```bash
pnpm turbo build --filter=@workspace/agent-tools
pnpm turbo dev --filter=@workspace/agent-tools   # tsc --build --watch
```
