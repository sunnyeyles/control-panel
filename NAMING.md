# NAMING.md

How an identifier is formed in this repo.

`CONTEXT.md` says what the words mean. This says where they go. Both are binding,
and the split is deliberate: the glossary is about the domain and survives any
rewrite, while the rules below are about the code and would change if the
architecture did.

Every rule here is a description of what the best modules already do. None of it
is new taste. It is written down because conventions that live only in docblocks
get re-derived per feature, and the derivations disagree — which is how one
dependency once came to be called five different things in seven files.

**Rules R2, R3, R5, R8 and R9 are enforced by tests**, in
`apps/dashboard/lib/naming.test.ts`, `packages/agents/src/naming.test.ts` and
`packages/agent-tools/src/naming.test.ts`. ESLint cannot do it:
`eslint-plugin-only-warn` downgrades every rule, so `pnpm lint` exits 0
regardless. The rest are conventions a reviewer upholds.

---

## R1 — `CONTEXT.md` owns every domain word, in identifiers as well as prose

An identifier either uses a glossary term as the glossary defines it, or does not
use the word at all. The **Avoid** list in each glossary entry is a ban on
identifiers, not only on prose.

The load-bearing case is **`resume`**. An upload is a **Document**, whatever its
**Document Type** says, and `resumes` is only the storage kind every upload goes
on. A local called `resumeId` holding a document's id is the same error as a
paragraph that calls every upload a CV, and it is worse, because the next reader
has to open the type to find out.

```ts
// no
const resumeId = crypto.randomUUID()

// yes
const documentId = crypto.randomUUID()
```

Not tested: whether a word is used as the glossary defines it is a judgement,
and a lexical match cannot make it. The one place `resumeId` is still spelled is
a storage field name, and it is listed under Known exceptions below.

## R2 — an agent seam is named after the agent's exported factory

A `*Deps` field that constructs an agent takes the **exact name**
`@workspace/agents` exports for it:

```ts
export interface ChatHandlerDeps {
  createAssistant?: () => Agent // not createAgent
}
```

Never a role verb or a generic one. `createAgent` is already the runtime's own
factory in `@workspace/agents-core`, and two agents can share a role — then two
files disagree about what the word means. The factory name is unique by
construction, so the seam inherits that uniqueness for free. Where the seam's
default is the real factory, import it under another name
(`createAssistant as defaultAssistant`) rather than bending the field.

The current set: `createAssistant`, `createWhiteboardAgent`. The test derives it
from the package's own exports rather than repeating it, so a new agent needs no
edit here.

## R3 — an agent module in `@workspace/agents` has one fixed surface

Three names, all re-exported from `index.ts`:

| Name                    | What it is                                  |
| ----------------------- | ------------------------------------------- |
| `<AGENT>_SYSTEM_PROMPT` | the prompt, as a `const`                    |
| `Create<Agent>Options`  | the factory's options                       |
| `create<Agent>`         | the factory (never a module-level instance) |

Uniform so a reader can find any agent's prompt without opening its module, and
so a prompt can be asserted on from a test that does not import the model. A
prompt constant that is declared but not exported, or exported but missing from
`index.ts`, compiles and breaks nothing — which is exactly how several had drifted
before this rule had a test.

A trailing `Agent` is a category noun rather than part of the name, and is
dropped from the prompt's: `createWhiteboardAgent` pairs with
`WHITEBOARD_SYSTEM_PROMPT`.

## R4 — prompt builders and parsers are named for their output, never their input

`to<Output>Prompt` and `parse<Output>`. A builder takes whatever it needs; what
makes it findable is the thing it is asking the model for.

Neither agent here takes a request object today — the Assistant reads the
conversation, and the whiteboard agent has its **Board Context** rendered into
its system prompt by `renderBoardContext` — so there is no builder to point at.
The rule stands for the next one, and keeps its number so the rules after it
keep theirs.

## R5 — type suffixes have fixed meanings

| Suffix             | Means                                                           |
| ------------------ | --------------------------------------------------------------- |
| `<X>Schema`        | a Zod schema                                                    |
| `Create<X>Options` | options to a factory                                            |
| `<X>ActionsDeps`   | the injected seams of a Server Action factory                   |
| `<X>Actions`       | what `create<X>Actions(deps)` returns                           |
| `<X>Row`           | a shape `@workspace/db` returns — `Date` fields and all         |
| `<X>View`          | a client-safe server projection — every `Date` already a string |
| `<X>Ref`           | an object-store address                                         |
| `<X>Session`       | a stateful agent handle                                         |

`View` versus `Row` is the one worth being strict about: it is the serialization
boundary, and a `Row` that reaches a client component is a runtime error about
`Date` rather than a type error. **`naming.test.ts` fails a file under
`components/` that imports a name ending in `Row` from `@/lib/…` or
`@workspace/db`** — the specifier is checked first, so `TableRow` from
`@workspace/ui` is untouched.

One consequence worth stating, because it was got wrong before the rule was
written down: **where a column's word differs from the glossary's, the
translation happens once, at the `packages/db` boundary.** `documents.doc_type`
is Prisma's `docType` and becomes `documentType` in
`lib/documents/list-documents.ts`. The column keeps its name — renaming it is a
migration nobody needs — and exactly one line knows both spellings.

## R6 — two outcomes use `ok`, three or more use `status`

```ts
type Caller = { ok: true; userId: string } | { ok: false; message: string }

type ActionState =
  | { status: "idle" }
  | { status: "error"; … }
  | { status: "success"; … }
```

Already the split everywhere — `Caller` and the upload check in
`lib/documents/upload-validation.ts` are `ok`; `CurrentUser` and `ActionState`
are `status` — and unstated until now, which left it one merge from being lost.
**No renames follow from this rule.** A two-case `status` is not wrong so much as
it is a promise that a third case is coming.

## R7 — a `*Deps` interface uses fixed field names

| Field             | For                                                        |
| ----------------- | ---------------------------------------------------------- |
| `getX()`          | a resource accessor — `getUser`, `getPrisma`, `getResumes` |
| `create<Agent>()` | an agent seam (R2)                                         |

Accessors are functions rather than values so nothing is constructed at module
scope; the optional ones are optional because the real implementation is the
default and only a test supplies another.

## R8 — `components/` mirrors the route tree

`components/<section>/<segment>/`, one directory per URL segment that owns
components. Components shared across sections sit at the top of `components/`,
or in a declared shared group — `forms/` is the one.

```
app/(app)/documents/   → components/documents/
app/(app)/whiteboard/  → components/whiteboard/
```

So the directory a page's components live in is the page's own URL, and a
directory that matches no route is a failing test rather than the start of a
second convention.

**`lib/` does not follow this rule and should not.** Its directories name domain
concepts (`lib/auth/`, `lib/actions/`, `lib/documents/`), several of which serve
more than one route. A component belongs to a page; a module belongs to a
concept.

## R9 — a tool in `@workspace/agent-tools` is named for the model, and lives in its domain

**A tool name is `snake_case` and unique across the catalog.** `get_current_time`,
`web_search`, `draw_diagram`. Uniqueness is not a style preference:
`createToolRegistry` in `@workspace/agents-core` throws on a duplicate, so a
collision is a runtime failure at agent construction — far from the edit that
caused it, and only on the agent unlucky enough to carry both. Tested by
`packages/agent-tools/src/naming.test.ts`, which builds every tool the package
can produce and asserts against the real `name` a model would see.

**A module goes in the directory of the domain it serves**, not in one named for
whether it is a tool: `whiteboard/`, or the package root for the two that serve
no domain. A tool is a thin wrapper over the support code beside it, and
splitting tools from support would put every feature in two places. `internal/`
is the exception and holds what has no domain at all — the shared HTTP transport
— and is not in the exports map.

---

## Known exceptions

Deliberate, bounded, and not to be "fixed" without reading why.

**`ResumeStore` in `packages/user-storage/` holds every upload, not CVs.** The
storage kind `resumes` is the shelf portfolios, certifications and cover letters
all go on. `CONTEXT.md` sets out the collision at length under **Document**. The
kind itself **cannot** be renamed — it is an S3 object tag that lifecycle rules
key off, so changing it orphans the retention policy on every existing object.

The TypeScript surface around it (`ResumeStore`, `StoredResume`, `NewResume`,
`ResumeRef`, `put({ resumeId })`) _could_ be renamed, and should be eventually,
but the change crosses `packages/user-storage` and the dashboard at once. Until
then the dashboard keeps the misnomer to a single line:

```ts
await deps.getResumes().put({ resumeId: documentId, … })
```

— ours is `documentId` everywhere; `resumeId` appears only where it is
`ResumeStore`'s field name and not our word.
