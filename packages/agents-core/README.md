# `@workspace/agents-core`

The LangGraph agent runtime: state schema, tool registry, and the compiled graph.

```
START → model ⇄ tools
          ↓
         END
```

`model` calls the chat model. The router sends it to `tools` whenever the reply
carries tool calls, and `tools` loops back. If the model-call budget runs out
first, the run is diverted to a `halt` node that answers every outstanding tool
call with an error — an unanswered tool call would be rejected on the next turn.

## Where this sits

This package is the runtime only. It ships **no tools and no agents**: the
shared tool catalog lives in `@workspace/agent-tools`, and named agents in
`@workspace/agents`.

```
@workspace/agents        prompt + tool set per named agent
        ↓
@workspace/agents-core   this package — graph, state, model, tool registry
@workspace/agent-tools   the tool catalog (independent of this package)
```

Take this package directly when a project brings its own prompt and tools; take
`@workspace/agents` when it wants one off the shelf.

## Usage

```ts
import { HumanMessage } from "@langchain/core/messages"
import { getCurrentTime } from "@workspace/agent-tools/time"
import { createAgent } from "@workspace/agents-core"

const agent = createAgent({ tools: [getCurrentTime] })

const result = await agent.invoke({
  messages: [new HumanMessage("What time is it in Sydney?")],
})

console.log(result.messages.at(-1)?.text)
```

Requires `OPENAI_API_KEY` in the environment (or pass `apiKey` via
`createModel({ apiKey })` and hand the model to `createAgent({ model })`).

`tools` defaults to none — omit it and you get a plain chat model with no tool
calling, which is occasionally what you want and otherwise a bug.

### Tools

Tools are plain LangChain tools (`StructuredToolInterface`), so anything built
with `tool()` works. Mix the catalog with your own:

```ts
import { tool } from "@langchain/core/tools"
import * as z from "zod"
import { getCurrentTime } from "@workspace/agent-tools/time"
import { createAgent } from "@workspace/agents-core"

const searchMessages = tool(async ({ query }) => "...", {
  name: "search_messages",
  description:
    "Search the mailbox. Use this before answering anything about email.",
  schema: z.object({ query: z.string().describe("What to search for.") }),
})

const agent = createAgent({ tools: [getCurrentTime, searchMessages] })
```

A tool worth sharing belongs in `@workspace/agent-tools`; keep one here only
while it is specific to a single caller. Names must be unique —
`createToolRegistry` throws on duplicates rather than letting one tool silently
shadow another.

### Persisting conversations

Pass a checkpointer and a `thread_id`; the graph then resumes prior history:

```ts
import { MemorySaver } from "@langchain/langgraph"

const agent = createAgent({ checkpointer: new MemorySaver() })
const config = { configurable: { thread_id: "some-thread" } }

await agent.invoke({ messages: [new HumanMessage("hi")] }, config)
await agent.invoke(
  { messages: [new HumanMessage("what did I just say?")] },
  config
)
```

`MemorySaver` is in-process only — swap in a durable checkpointer to survive a
restart.

### Streaming

The compiled graph is a normal LangGraph runnable. To feed an AI SDK UI via
`@ai-sdk/langchain`'s `toUIMessageStream`, stream with exactly this pair of
modes — it detects a LangGraph stream by the `[mode, payload]` tuples an
array of modes produces, then reads `"messages"` events for tokens and
`"values"` for final state (this is what `apps/dashboard`'s chat route does):

```ts
const stream = await agent.stream(input, {
  streamMode: ["values", "messages"],
})
```

For plain terminal logging, any single mode works:

```ts
for await (const chunk of await agent.stream(input, {
  streamMode: "updates",
})) {
  console.log(chunk)
}
```

## Model configuration

Uses OpenAI via `@langchain/openai`. The default is `DEFAULT_MODEL` in
`src/model.ts` — read it there rather than trusting a name written here. Two
things to know:

- **`temperature` is not set.** Reasoning-capable models reject a non-default
  value. Pass it through `overrides` only on a model that accepts it.
- **`maxTokens` is left unset.** On reasoning-capable models the output cap also
  covers reasoning tokens, so a tight cap truncates the answer.

Swapping providers means passing any model that satisfies `ChatModelLike` to
`createAgent({ model })` — `src/model.ts` is the only OpenAI-specific file;
nothing in the graph, state, or tools is provider-specific.

## Build

Consumed as built output (`dist/`), not as source — unlike `@workspace/ui`. Turbo's
`build.dependsOn: ["^build"]` orders this ahead of any package that imports it.

```bash
pnpm turbo build --filter=@workspace/agents-core
pnpm turbo typecheck --filter=@workspace/agents-core
```

Use `pnpm turbo dev --filter=@workspace/agents-core` (`tsc --build --watch`) while
iterating, so consumers pick up changes without a manual rebuild.
