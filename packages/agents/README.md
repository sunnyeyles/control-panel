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

## The Posting contract

`src/findings.ts` holds two shapes that differ by one field. The scout reports a
`ScoutPosting`, which names a posting by the `id` a search gave it; the worker
resolves that id against the run's posting catalog and stores a `Posting`, which
carries the `url` the board issued. Everything downstream reads the second and
has never heard of the first.

Both extend one definition of the composed fields, so adding a field to
`PostingFieldsSchema` is the whole change — the scout starts being asked for it
and the stored record starts carrying it. `ScoutFindingsSchema` _is_ the argument
schema of the `submit_findings` tool, so the provider validates the hand-off:
a model that gets the shape wrong is told so in a tool result and corrects it,
where a malformed final message used to fail the entire run.

Three field-level rules the schemas exist to hold:

- **The scout never sees a URL.** A URL it cannot read is a URL it cannot
  mistype, and mistyping one cost seven production runs over 2026-08-05/06 —
  the evidence is in the worker's `resolve-postings.ts`. It reports an id, and
  an id no search returned resolves to nothing, so fabrication is structural
  rather than caught by comparison.
- **`highlights` is copied, never composed.** A bullet point the scout
  summarised rather than reproduced is a fabrication. It is optional so that
  omitting it stays the honest answer — and so every Findings record written
  before the field existed still parses.
- **`summary` and `matchReason` are composed**, and nothing derived from a
  Posting should be built out of them.

`postingId(posting)` is what "derived from a copied field" buys: a stable
16-character hex id hashed from the normalised `url`, so the same advertisement
found in two Runs gets one id. Its output is a valid object key segment for
`@workspace/user-storage` unmodified. The normalisation rule is written out in
`src/posting-id.ts`.

## The cover letter, and why it has no tools

`src/cover-letter.ts` is the contract — `CandidateProfileSchema`,
`CoverLetterRequestSchema`, `assertDraftable()`, the pure `toCoverLetterPrompt()`
and the background bounds — and `src/cover-letter-writer.ts` is the agent that
consumes it. The split is the same one `findings.ts` makes: the contract belongs
to neither the caller nor the model.

**`tools: []` here is containment, not taste.** The writer holds the candidate's
CV in its context, and the Posting beside it is attacker-influenced text —
anyone who can pay to place an advertisement writes it, and `highlights` reaches
the prompt _verbatim_, so an instruction hidden in a bullet point survives
copying intact. An agent that can both read a CV and issue an outbound request
can be induced to put one inside the other. Having no tools is exactly what
makes copying the advertisement acceptable: injected text can shape the prose of
a draft the user then reads, and can reach nothing else. `bindTools` is asserted
to receive `[]` in the test suite, against a fake chat model, so this is checked
rather than asserted in prose.

**`assertDraftable()` refuses before the model is called**, when the background
is absent, under `MIN_BACKGROUND_CHARS` or over `MAX_BACKGROUND_CHARS`. It
refuses rather than truncating: a letter written from half a CV, with nothing
saying so, reads exactly like one written from all of it. That is the same
silent-fabrication guard as "a run with no successful search fails", applied to
a document that asserts things about a person.

**A missing fact is a `[bracketed placeholder]`.** Start date, salary, a named
recipient — where nobody supplied it, the prompt requires a visible gap. A
plausible invention attributed to the user is a lie; a gap is a draft.

## The tailored resume, and the one rule it does not share

`src/tailored-resume.ts` and `src/resume-tailor.ts` are the same pair one more
time — a pure contract with `TailoredResumeRequestSchema` and
`toTailoredResumePrompt()`, and a zero-tool agent that consumes it. **`tools: []`
for the identical reason**, and the case is if anything stronger: this agent
holds the whole CV and its output is a rewrite of that CV, with the
advertisement's `highlights` reaching the prompt verbatim beside it.

**The bounds are reused, not restated.** `assertDraftable()` and
`UndraftableError` come from `cover-letter.ts`; the guard takes a structural
`{ background }` for exactly this, and the question it answers is the same one —
is there enough of this person's own document to work from? A second copy of
`MIN_BACKGROUND_CHARS` would be a second number to keep in step with the first.

What differs is the honesty rule, and it inverts:

- The Letter Writer writes _about_ the CV, and leaves a `[bracketed placeholder]`
  wherever a fact nobody supplied would otherwise be invented.
- The Resume Tailor rewrites _the CV itself_, and **may leave nothing in it that
  is not already there**: every line must have a counterpart in the source, so no
  employer, date, metric, qualification or technology may be added and no claim
  upgraded. It writes **no placeholders at all** — a resume is read as a list of
  facts, and `[metric]` sitting in an experience bullet is a broken document
  rather than a visible gap, so anything unknown is simply left out.

The prompt is the only place that rule exists: the output is markdown and the
source is markdown, so nothing downstream can tell a reordered CV from an
embellished one. `resume-tailor.test.ts` therefore asserts the clauses
individually, so dropping one is a test failure rather than a quietly worse
document.

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
pnpm turbo test --filter=@workspace/agents
```

Tests sit beside the code as `src/**/*.test.ts`, excluded from `tsconfig.json`
so they never reach `dist/` and covered by `tsconfig.test.json` instead —
`typecheck` runs both. The suite covers the contract, not the models: nothing in
it needs `OPENAI_API_KEY`.
