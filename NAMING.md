# NAMING.md

How an identifier is formed in this repo.

`CONTEXT.md` says what the words mean. This says where they go. Both are binding,
and the split is deliberate: the glossary is about the domain and survives any
rewrite, while the rules below are about the code and would change if the
architecture did.

Every rule here is a description of what the best modules already do. None of it
is new taste. It is written down because conventions that live only in docblocks
get re-derived per feature, and the derivations disagree — which is exactly how
the same dependency came to be called `createWriter`, `createTailor`,
`createAssessor`, `createExtractor` and `createAgent` in seven files.

**Rules R1, R2, R3, R5 and R8 are enforced by tests**, in
`apps/dashboard/lib/naming.test.ts` and `packages/agents/src/naming.test.ts`.
ESLint cannot do it: `eslint-plugin-only-warn` downgrades every rule, so
`pnpm lint` exits 0 regardless. The rest are conventions a reviewer upholds.

---

## R1 — `CONTEXT.md` owns every domain word, in identifiers as well as prose

An identifier either uses a glossary term as the glossary defines it, or does not
use the word at all. The **Avoid** list in each glossary entry is a ban on
identifiers, not only on prose.

The load-bearing case is **`job`**. It names a row in `jobs` — a thing that runs
on a cadence — and never an employment opportunity, which is a **Posting**. A
local variable called `job` holding a posting is the same error as a paragraph
that calls a posting a job, and it is worse, because the next reader has to open
the type to find out.

```ts
// no
async function scoreOne(prisma: PrismaClient, job: { postingId: string; … })

// yes
async function scoreOne(prisma: PrismaClient, assessment: { postingId: string; … })
```

Enforced for `job`/`jobs` by an allowlist in `apps/dashboard/lib/naming.test.ts`.
The allowlist is the documentation: a module that genuinely handles `jobs` rows
is added to it deliberately, and the addition is visible in review.

**Corollary — `job` and `briefing` are the same row seen from two sides, and
which word you use is decided by where you are.** The schema owns `jobs`, and
`CONTEXT.md` gives the user-facing word to **Briefing**. So: `job` inside
`packages/db` and in the dashboard modules that read `jobs` rows, `briefing`
everywhere a user can see it — a heading, a button, a message, a route's copy.
That is what `JOBS_ALLOWLIST` has been encoding without saying so, and it is why
`components/jobs/schedules/` holds `job-schedule-form.tsx` beside
`create-briefing-form.tsx` and neither is a mistake. A file that reads the rows
and renders the words carries both, and `briefing-section.tsx` is the one that
does.

## R2 — an agent seam is named after the agent's exported factory

A `*Deps` field that constructs an agent takes the **exact name**
`@workspace/agents` exports for it:

```ts
export interface MatchActionsDeps {
  createMatchAssessor?: () => Agent // not createAssessor
}
```

Never a role verb. Two agents can share a role — `createExtractor` named both the
Posting Extractor and the Profile Extractor — and then two files disagree about
what the word means. The factory name is unique by construction, so the seam
inherits that uniqueness for free.

The current set: `createAssistant`, `createBriefWriter`, `createCoverLetterWriter`,
`createJobScout`, `createMatchAssessor`, `createPostingExtractor`,
`createProfileExtractor`, `createResumeTailor`, `createWhiteboardAgent`. The test
derives it from the package's own exports rather than repeating it, so a new agent
needs no edit here.

## R3 — an agent module in `@workspace/agents` has one fixed surface

Three names, all re-exported from `index.ts`:

| Name                    | What it is                                  |
| ----------------------- | ------------------------------------------- |
| `<AGENT>_SYSTEM_PROMPT` | the prompt, as a `const`                    |
| `Create<Agent>Options`  | the factory's options                       |
| `create<Agent>`         | the factory (never a module-level instance) |

Uniform so a reader can find any agent's prompt without opening its module, and
so a prompt can be asserted on from a test that does not import the model. The
two constants that were missing — `BRIEF_WRITER_SYSTEM_PROMPT` unexported and
`PROFILE_EXTRACTOR_SYSTEM_PROMPT` absent from `index.ts` — are what this rule was
written to catch.

## R4 — prompt builders and parsers are named for their output, never their input

`to<Output>Prompt` and `parse<Output>`. A builder takes whatever it needs; what
makes it findable is the thing it is asking the model for.

`toCoverLetterPrompt`, `toMatchPrompt`, `toPostingExtractionPrompt`,
`toTailoredResumePrompt`, `toSearchCriteriaPrompt` — the last of which takes a
profile and was called `toProfilePrompt`, the only one named for its argument.

## R5 — type suffixes have fixed meanings

| Suffix             | Means                                                           |
| ------------------ | --------------------------------------------------------------- |
| `<X>Schema`        | a Zod schema                                                    |
| `Create<X>Options` | options to a factory                                            |
| `<X>ActionsDeps`   | the injected seams of a Server Action factory                   |
| `<X>Actions`       | what `create<X>Actions(deps)` returns                           |
| `<X>Request`       | the input handed to an agent                                    |
| `<X>Row`           | a shape `@workspace/db` returns — `Date` fields and all         |
| `<X>View`          | a client-safe server projection — every `Date` already a string |
| `<X>Ref`           | an object-store address                                         |
| `<X>Result`        | a returned discriminated union                                  |
| `<X>Page`          | a paginated slice, with its total and page count                |
| `<X>Session`       | a stateful agent handle                                         |

`View` versus `Row` is the one worth being strict about: it is the serialization
boundary, and a `Row` that reaches a client component is a runtime error about
`Date` rather than a type error. **`naming.test.ts` fails a file under
`components/` that imports a name ending in `Row` from `@/lib/…` or
`@workspace/db`** — the specifier is checked first, so `TableRow` from
`@workspace/ui` is untouched.

Two consequences worth stating, because both were got wrong before the rule was
written down:

- **`Row` is about where the shape came from, not about what renders it.** The
  cover letters and tailored resumes are projections of an **S3 listing** and
  there is no `cover_letters` table for them to be rows of, so they are
  `CoverLetterView` and `TailoredResumeView` — they were `…Row` until this rule
  had a test, which is exactly how long a convention survives without one.
- **Where a column's word differs from the glossary's, the translation happens
  once, at the `packages/db` boundary.** `documents.doc_type` is Prisma's
  `docType` and becomes `documentType` in `lib/documents/list-documents.ts`;
  `postings.match_resume_id` is Prisma's `matchResumeId` and becomes
  `documentId` on `PostingMatchRow` and `PostingMatchWrite`. The column keeps
  its name — renaming it is a migration nobody needs — and exactly one line each
  way knows both spellings.

## R6 — two outcomes use `ok`, three or more use `status`

```ts
type Caller = { ok: true; userId: string } | { ok: false; message: string }

type StoredPostingResult =
  | { status: "stored"; … }
  | { status: "duplicate"; … }
  | { status: "rejected"; … }
```

Already the split everywhere — `Caller` and `CandidateBackground` are `ok`, every
`*ActionResult` is `status` — and unstated until now, which left it one merge from
being lost. **No renames follow from this rule.** A two-case `status` is not wrong
so much as it is a promise that a third case is coming.

Corollary: a bare `status` field on a _value_ type is the domain status column —
`PostingStatus`, `runs.status` — never a control-flow discriminant. When both
appear on one object the discriminant wins the name and the column gets qualified.

## R7 — a `*Deps` interface uses fixed field names

| Field             | For                                                        |
| ----------------- | ---------------------------------------------------------- |
| `getX()`          | a resource accessor — `getUser`, `getPrisma`, `getResumes` |
| `create<Agent>()` | an agent seam (R2)                                         |
| `now?`            | the clock                                                  |
| `newResetKey?`    | the form-remount key                                       |

Accessors are functions rather than values so nothing is constructed at module
scope; the optional ones are optional because the real implementation is the
default and only a test supplies another.

## R8 — `components/` mirrors the route tree

`components/<section>/<segment>/`, one directory per URL segment that owns
components. Components shared across sections sit at the top of `components/`.

```
app/(app)/jobs/            → components/jobs/
app/(app)/jobs/schedules/  → components/jobs/schedules/
app/(app)/jobs/letters/    → components/jobs/letters/
app/(app)/documents/       → components/documents/
```

The rule exists because the alternative was three conventions at once: `/jobs`
read from `components/jobs/postings/`, `/jobs/schedules` from
`components/jobs/schedules/`, and `/jobs/letters` from `components/jobs/letters/`
— so `jobs` was two directories meaning two different things, and `briefings`
held the Postings table.

**`lib/` does not follow this rule and should not.** Its directories name domain
concepts (`lib/postings/`, `lib/candidate/`, `lib/briefing-runs/`), several of
which serve more than one route. A component belongs to a page; a module belongs
to a concept.

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
but the change crosses `packages/user-storage`, `apps/briefing-worker` and the
dashboard at once. Until then the dashboard keeps the misnomer to a single line:

```ts
await deps.getResumes().put({ resumeId: documentId, … })
```

— ours is `documentId` everywhere; `resumeId` appears only where it is
`ResumeStore`'s field name and not our word.

**`postings.match_resume_id` was the second source of `resumeId` and is no
longer one.** `@workspace/db` used to carry the column's word out through
`PostingMatchRow`, `PostingMatchWrite`, `listUnmatchedPostingIds` and
`countUnmatchedPostings`, which made a dashboard module declare
`const resumeId = background.documentId` to feed it. It is `documentId` on all
four now, translated at the boundary per R5. The **column** is untouched and
stays `match_resume_id`; only `packages/db/src/postings.ts` and the Prisma-shaped
test fakes may spell it that way.
