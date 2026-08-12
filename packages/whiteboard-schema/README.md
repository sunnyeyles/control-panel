# `@workspace/whiteboard-schema`

The whiteboard wire contract: what the browser sends up about the board, and
what the agent sends back for the browser to apply.

```ts
import { boardContextSchema, type CanvasOp } from "@workspace/whiteboard-schema"
```

## Why it is a package and not a module

**Both ends of the wire import it**, which is the whole reason it can be the one
place they agree. The agent's canvas tools are in
`@workspace/agent-tools/whiteboard/`; the applier, the simplifier and the tldraw
surface are in `apps/dashboard/lib/whiteboard/` and
`apps/dashboard/components/whiteboard/`, several of them client components.

It used to live inside `@workspace/agent-tools` as `canvas-schema.ts`, which
meant a browser bundle reached into a package named "agent tools" and waited on
its build for a type. The module's own header already described a contracts
package — it imports zod and nothing else, deliberately, because a dependency on
anything server-shaped (or on tldraw) would make one of the two ends unable to
import it. This is that, made structural.

**It depends on zod and nothing else, and it must stay that way.** Anything
added here is added to a client bundle.

## What is in it

Every type is inferred from a schema rather than declared beside one, so a field
cannot be added to the type and forgotten in the validation.

Two vocabulary decisions run through the file, and both are explained at length
in its header:

- **Shape kinds are semantic, not tldraw's.** The model asks for a `cloud` or a
  `note`; the client decides that means `geo`/`cloud` or `note`.
- **Ids are the short half of a tldraw id.** `s7` here is `shape:s7` there, and
  the conversion is a prefix — so there is no id map to fall out of sync.

## Build

Consumed as built output (`dist/`), exactly as `@workspace/agent-tools` is, and
with no `transpilePackages` entry in the dashboard: the emitted ESM resolves in
a client component as it stands.

```bash
pnpm turbo build --filter=@workspace/whiteboard-schema
```

⚠️ **The worker bundles this transitively.** `apps/briefing-worker` reaches it
through `@workspace/agents`, so `packages/whiteboard-schema/**` is in
`deploy-infra.yml`'s path filter. A change here that is not in that list would
not redeploy the worker.
