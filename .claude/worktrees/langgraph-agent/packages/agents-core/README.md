# `@workspace/agents-core`

The LangGraph agent runtime: state schema, tool registry, and the compiled graph.

```
START → model ⇄ tools
          ↓
         END
```

`model` calls Claude. The router sends it to `tools` whenever the reply carries
tool calls, and `tools` loops back. If the model-call budget runs out first, the
run is diverted to a `halt` node that answers every outstanding tool call with an
error — an unanswered `tool_use` block would be rejected on the next turn.

## Usage

```ts
import { HumanMessage } from "@langchain/core/messages"
import { createAgent } from "@workspace/agents-core"

const agent = createAgent()

const result = await agent.invoke({
  messages: [new HumanMessage("What time is it in Sydney?")],
})

console.log(result.messages.at(-1)?.text)
```

Requires `OPENAI_API_KEY` in the environment (or pass `apiKey` to
`createModel()` and hand the model to `createAgent({ model })`).

### Adding tools

Tools are plain LangChain tools. Pass your own set to replace the defaults:

```ts
import { tool } from "@langchain/core/tools"
import * as z from "zod"
import { createAgent, defaultTools } from "@workspace/agents-core"

const searchMessages = tool(async ({ query }) => "...", {
  name: "search_messages",
  description:
    "Search the mailbox. Use this before answering anything about email.",
  schema: z.object({ query: z.string().describe("What to search for.") }),
})

const agent = createAgent({ tools: [...defaultTools, searchMessages] })
```

Write tool descriptions for the model, not for a human, and say _when_ to call
the tool rather than only what it does — that measurably raises the should-call
rate. Names must be unique; `createToolRegistry` throws on duplicates rather
than letting one tool silently shadow another.

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

The compiled graph is a normal LangGraph runnable:

```ts
for await (const chunk of await agent.stream(input, {
  streamMode: "updates",
})) {
  console.log(chunk)
}
```

## Model configuration

Uses OpenAI via `@langchain/openai`, defaulting to `gpt-5.5` (see
`src/model.ts`). Two things to know:

- **`temperature` is not set.** Reasoning-capable models reject a non-default
  value. Pass it through `overrides` only on a model that accepts it.
- **`maxTokens` is left unset.** On reasoning-capable models the output cap also
  covers reasoning tokens, so a tight cap truncates the answer.

Swapping providers means changing `src/model.ts` and the `model?:` type in
`src/agent.ts` — nothing in the graph, state, or tools is provider-specific.

## Build

Consumed as built output (`dist/`), not as source — unlike `@workspace/ui`. Turbo's
`build.dependsOn: ["^build"]` orders this ahead of any package that imports it.

```bash
pnpm turbo build --filter=@workspace/agents-core
pnpm turbo typecheck --filter=@workspace/agents-core
```

Use `pnpm turbo dev --filter=@workspace/agents-core` (`tsc --build --watch`) while
iterating, so consumers pick up changes without a manual rebuild.
