# `@workspace/agents`

Named agents — a system prompt plus a chosen tool set, built on
`@workspace/agents-core`. One agent per module.

```ts
import { HumanMessage } from "@langchain/core/messages"
import { createAssistant } from "@workspace/agents/assistant"

const assistant = createAssistant()

const result = await assistant.invoke({
  messages: [new HumanMessage("What time is it in Sydney?")],
})

console.log(result.messages.at(-1)?.text)
```

Requires `OPENAI_API_KEY` in the environment.

## Agents are factories, never instances

Every agent here is exported as a `createX()` function. Building an agent
constructs a model, which reads `OPENAI_API_KEY` and throws without one. A
module-level instance would move that failure to _import_ time, so any consumer
that merely imports the module — a Next.js route that is only rendered, a test
that imports a sibling export — would blow up rather than the code that actually
runs the agent.

Call the factory where you handle the request, not at module scope.

## Adding an agent

Create `src/<name>.ts` exporting a factory, and re-export it from `src/index.ts`.
The wildcard subpath export (`./*` → `./dist/*.js`) means
`@workspace/agents/<name>` works with no config change.

```ts
import { getCurrentTime } from "@workspace/agent-tools/time"
import { createAgent, type Agent } from "@workspace/agents-core"

export function createScheduler(): Agent {
  return createAgent({
    systemPrompt: "You schedule meetings. ...",
    tools: [getCurrentTime],
  })
}
```

Give an agent the tools its job needs rather than the whole catalog — a model
picks worse as the list grows.

## Where this sits

```
@workspace/agents        this package — prompt + tool set per named agent
        ↓
@workspace/agents-core   graph, state, model factory, tool registry
@workspace/agent-tools   the tool catalog (independent of the runtime)
```

A project that wants a ready-made agent takes this package. A project with its
own tools and prompt should take `@workspace/agents-core` directly instead.

## Build

```bash
pnpm turbo build --filter=@workspace/agents
pnpm turbo dev --filter=@workspace/agents   # tsc --build --watch
```
