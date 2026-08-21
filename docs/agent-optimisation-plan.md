# Agent optimisation opportunities

> Not built. Delete or rewrite this file when the work ships.

How the stack is shaped: `docs/agent-architecture.md`. This file is only what
to change, where, and what not to undo. Glossary: `CONTEXT.md` — a **Job** is a
row in `jobs`; an employment opportunity is a **Posting**.

## Current picture

All five agents use `createModel()` → `DEFAULT_MODEL` (`gpt-5.4-mini`) unless a
caller passes `model`. None do.

| Agent               | Factory                   | Tools        | Output                              |
| ------------------- | ------------------------- | ------------ | ----------------------------------- |
| Scout               | `createJobScout`          | `seekSearch` | JSON Findings (prose + parse)       |
| Brief Writer        | `createBriefWriter`       | none         | Markdown Brief                      |
| Profile Extractor   | `createProfileExtractor`  | none         | JSON SearchCriteria (prose + parse) |
| Cover Letter Writer | `createCoverLetterWriter` | none         | Markdown letter                     |
| Assistant           | `createAssistant`         | `allTools`   | Open chat stream                    |

Order: **1 → 2 → 3 → 4 → 5**; **6** only after traces. Pair cheaper Extractor
models with §2, not before.

---

## 1. Tier models by job

**Do:** Give each factory a default model via existing `model` / `createModel({
model })`. Keep `DEFAULT_MODEL` as the runtime fallback.

| Agent               | Default                                          |
| ------------------- | ------------------------------------------------ |
| Scout               | Capable tool-calling (keep or stronger)          |
| Assistant           | Mid / capable                                    |
| Brief Writer        | Cheaper, non-reasoning                           |
| Profile Extractor   | Cheaper — with §2                                |
| Cover Letter Writer | Mid (quality-sensitive; compare before swapping) |

**Touch:** `packages/agents/src/{job-scout,assistant,brief-writer,profile-extractor,cover-letter-writer}.ts`; document beside `packages/agents-core/src/model.ts`.

**Done when:** Each factory’s default is explicit and still overridable; tests
that inject `model` still pass.

**Don’t:** Delete `DEFAULT_MODEL`. Silent cover-letter model swap without a
quality check.

---

## 2. Structured output for JSON agents

**Do:** Stop asking for JSON-in-prose. Keep Zod schemas as the contract.

- Extractor (easy): tool-less path + `withStructuredOutput(SearchCriteriaSchema)`.
- Scout (harder): terminal tool whose args are `FindingsSchema`, **or**
  structured output only on the final turn after search tools stop. Whole-run
  constrained decode fights tool calling.

**Touch:** `packages/agents/src/{criteria,findings,profile-extractor,job-scout}.ts`;
worker handoff in `apps/briefing-worker/src/run-briefing.ts`; suggest-criteria
in `apps/dashboard/lib/jobs/suggest-criteria-actions.ts`.

**Done when:** Schema text is gone from those system prompts; fence-stripping
is unused on the happy path; worker still enforces ≥1 successful search and
verbatim Posting URLs.

**Don’t:** Structured output on Brief Writer or Cover Letter Writer. Drop
search-evidence / URL checks because “the JSON was valid”.

---

## 3. Short-circuit empty Scout results

**Do:** If `findings.postings.length === 0` after a valid handoff, skip
`createBriefWriter`. Upload a short template Brief (state nothing found;
include Scout `notes` if present). Same store / finish / Findings path. Trace
writer as template, not a model call.

**Touch:** `apps/briefing-worker/src/run-briefing.ts`.

**Done when:** Empty Findings runs upload a Brief with zero Writer LLM calls;
Scout failures (no search, bad URL, parse error) still fail the run.

**Don’t:** Short-circuit on Scout failure. Fancy template that mimics Writer
voice.

---

## 4. Memoize compiled agents across requests

**Do:** Process-level memo at the composition root (dashboard / worker), after
first real use — not inside `createAgent`, not at `@workspace/agents` import
time.

Memoize: Assistant, Scout, Brief Writer, Profile Extractor defaults.

Do **not** memoize a Cover Letter Writer closed over per-user
`coverLetterSystemPrompt(extras)` (cross-user prompt leak).

**Touch:** `apps/dashboard/lib/chat-handler.ts`,
`apps/dashboard/lib/jobs/suggest-criteria-actions.ts`,
`apps/dashboard/lib/cover-letters/cover-letter-actions.ts`,
`apps/briefing-worker/src/run-briefing.ts`.

**Done when:** Default agents are reused across requests on a warm process;
injectable seams still accept fakes; cover-letter prompts stay per-user.

**Don’t:** Module-scope construction in `@workspace/agents` (missing
`OPENAI_API_KEY` must fail at run time, not import).

---

## 5. Skip the LangGraph for tool-less agents

**Do:** For `tools: []`, use a single chat completion (helper or collapse
inside `createAgent`). Preserve call-site shape (`messages`, `llmCalls: 1`) and
Langfuse `callbacks` / `metadata` / `runName`. Pair Extractor with §2.

**Touch:** `packages/agents-core/src/agent.ts` (and/or a small helper);
Brief Writer, Profile Extractor, Cover Letter Writer factories; their
structural “no tools” tests.

**Done when:** Tool-less agents don’t compile a tools/halt loop; containment
tests still prove no tool dispatch; Scout and Assistant graphs unchanged.

**Don’t:** Collapse Scout or Assistant. Delete `bindTools([])` assertions
without an equivalent proof.

---

## 6. Tighten Scout search fan-out

**Do:** Measure first (Langfuse llm-call counts, searches-by-source). Prefer
fewer criteria upstream over lowering `JOB_SCOUT_MAX_LLM_CALLS`. Only cut the
budget if halt rate stays flat.

**Touch:** criteria / form validation; maybe Scout prompt; budget constant in
`packages/agents/src/job-scout.ts` only after data.

**Done when:** A decision is based on traces, not a guess.

**Don’t:** Blind budget cut. Prompt the Scout to “finish” in ways that invent
Postings.

---

## Not on this list

- Empty tool sets on Brief Writer / Cover Letter Writer / Profile Extractor
  (containment).
- Verbatim CV and Posting text in prompts.
- Shrinking Assistant `allTools` while the catalog is two tools.
- Import-time agent construction in `@workspace/agents`.
- Trusting structured output instead of search-evidence / verbatim-URL checks.
