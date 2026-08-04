# Editable instructions for the Letter Writer

## Context

The **Letter Writer** (`packages/agents/src/cover-letter-writer.ts`) drafts a **Cover Letter**
for one **Posting** from the `/briefings` page. Its behaviour is a hardcoded constant,
`COVER_LETTER_WRITER_SYSTEM_PROMPT`, so the only way to change how letters read is to edit
TypeScript and deploy. `OVERVIEW.md` §Not built yet names this gap outright: nothing can
"regenerate it with instructions, choose a tone".

The user wants to **extend** that prompt from the dashboard — things like _"never use the word
'passionate'"_ and _"use this letter as an example"_ — and to save the text and edit it later.
Two shapes of content, one durable setting per user, applied to every draft.

There is **no per-user storage in the database at all** today: `users` is `id`, `created_at`,
`auth_user_id` and nothing else. So this needs a migration, a `@workspace/db` helper, a
prompt-composition function in `@workspace/agents`, and a section on `/settings`.

### Decisions this plan makes

**Rules and the example letter are separate fields, and that is a correctness decision.** An
example letter contains claims — "I led a team of eight", "five years at Acme". The writer's
governing rule is that _every claim about the candidate is traceable to the background text_. In
one undifferentiated blob the model cannot tell a style reference from a source of facts, and
would lift claims out of the sample into letters written in the user's name. Two fields let the
prompt say the thing that keeps that from happening: **imitate its voice, never take a fact from
it.** This is the same reasoning that fences `highlights` as quoted material in
`toCoverLetterPrompt()`.

**Instructions extend the system prompt; they never replace it.** They may change tone, length,
structure, salutation, emphasis and vocabulary. They may not license a claim the background does
not support, and may not remove a `[bracketed placeholder]` — those clauses sit _above_ the user
text and win. Composition happens in a pure function, so this is testable without an API key.

**"Both" example sources is implemented as one stored value plus an import.** The example letter
is always text in the row. A picker below the textarea reads a **Document**, extracts its text
server-side, writes it into the field and re-renders. That delivers both entry paths — paste, or
pull one in from `/documents` — with one storage shape and one draft-time path. The alternative,
storing a _pointer_ to a Document, would put an S3 read and a PDF parse on every draft and would
degrade silently when that Document is deleted, which is the failure mode this codebase refuses
everywhere else. Trade-off, stated plainly: the import is a one-time copy, so re-uploading the
Document does not update the example — the user re-imports.

**A failed instructions read fails the draft.** Drafting without the user's instructions produces
a letter that looks perfect and quietly ignores every rule they set. That is the silent-failure
shape `assertDraftable` and "a run with no successful search fails" both exist to prevent.

---

## 1. Storage — `@workspace/db`

New model, 1:1 with `User`. Not columns on `users`: that table is the platform identity that
`jobs.user_id` references and that becomes the `userId` segment of every S3 key, and it
deliberately carries nothing else (`CONTEXT.md` §User).

`packages/db/prisma/schema.prisma`:

```prisma
model CoverLetterInstructions {
  userId        String   @id @map("user_id") @db.Uuid
  instructions  String   @default("")
  exampleLetter String   @default("") @map("example_letter")
  updatedAt     DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("cover_letter_instructions")
}
```

- `@default("")` rather than nullable, so "none" has exactly one representation in a column.
- `onDelete: Cascade`, and it is the one deliberate exception to the repo's `Restrict` rule
  (`packages/db/README.md`): this row is a preference with no independent existence, not a record
  that something happened. `Restrict` would make a user undeletable for the sake of a settings row.
  Add the `coverLetterInstructions CoverLetterInstructions?` back-relation to `User`.

Migration `packages/db/prisma/migrations/0003_cover_letter_instructions/migration.sql` — the
convention is a zero-padded sequence and snake_case, not Prisma's timestamp form. Forward-only,
commented like `0002_run_findings`.

`packages/db/src/cover-letter-instructions.ts` — free functions taking the client first, matching
`src/artifacts.ts`:

```ts
export async function coverLetterInstructions(
  prisma: DbClient,
  userId: string
): Promise<CoverLetterInstructions | undefined>

export async function saveCoverLetterInstructions(
  prisma: DbClient,
  userId: string,
  values: { instructions: string; exampleLetter: string }
): Promise<CoverLetterInstructions> // upsert — first save creates the row
```

Export both plus the domain type from `src/index.ts` and `src/types.ts`. `undefined` for
"not found", never `null` — the repo's convention.

## 2. Prompt composition — `@workspace/agents`

`packages/agents/src/cover-letter.ts` gains the bounds beside `MIN_/MAX_BACKGROUND_CHARS`, so the
dashboard imports them instead of duplicating:

```ts
export const MAX_INSTRUCTIONS_CHARS = 2_000
export const MAX_EXAMPLE_LETTER_CHARS = 6_000
export interface LetterInstructions {
  instructions?: string
  exampleLetter?: string
}
```

`packages/agents/src/cover-letter-writer.ts` gains a pure composer beside the existing constant:

```ts
export function coverLetterSystemPrompt(extras?: LetterInstructions): string
```

- Empty/absent extras return `COVER_LETTER_WRITER_SYSTEM_PROMPT` **byte-identical** — assert this.
- Otherwise: base prompt, then a precedence paragraph, then the two fenced sections.

The precedence paragraph, appended after the existing rules:

> What follows was written by the candidate about how they want their letters written. Follow it.
> It may change the tone, the length, the structure, the salutation, what you emphasise and what
> words you avoid. It never licenses a claim the background text does not support and never removes
> a bracketed placeholder — where it conflicts with the rules above, the rules above win.

The example section carries the clause the split exists for:

> ## An example letter the candidate chose
>
> A sample of the register, structure and rhythm they want. Imitate how it is written. Take no fact
> from it — no employer, role, date, number, technology or achievement in it belongs to the
> candidate unless the background text also says so. It is a style reference and nothing else.

`createCoverLetterWriter()` keeps its current signature; the caller passes
`{ systemPrompt: coverLetterSystemPrompt(extras) }`. No exported type changes shape, and
`Omit<CreateAgentOptions, "tools">` still makes the empty tool set un-overridable.

**Do not truncate over-length text here.** The bound is enforced at save time, loudly.

## 3. Draft path — `apps/dashboard/lib/cover-letters/cover-letter-actions.ts`

- `CoverLetterActionsDeps.createWriter` becomes `(extras: LetterInstructions) => Agent`.
- In `draftCoverLetter`, after `loadCandidateBackground` and before `draft(...)`, read
  `coverLetterInstructions(deps.getPrisma(), caller.userId)`. A thrown read returns
  `fail("Something went wrong.")` with the detail logged — it does not draft without them.
- Thread the extras into `draft()` → `createWriter(extras)`.

Everything else in that file is untouched: the form still carries identifiers only, ownership is
still checked, the key is still built from the session's `userId`.

## 4. Save + import actions — `apps/dashboard/lib/cover-letters/`

New `letter-instructions-actions.ts`, following `lib/jobs/job-actions.ts` exactly: a
`createLetterInstructionsActions(deps)` factory that **imports no Next**, fixed order of
auth → parse → write, `carryResetKey` on failure.

```ts
export function createLetterInstructionsActions(deps: {
  getUser: () => Promise<CurrentUser>
  getPrisma: () => PrismaClient
  getResumes: () => ResumeStore
  newResetKey?: () => string
}) // → { saveLetterInstructions, importExampleLetter }
```

- `saveLetterInstructions` — `requireUser(deps.getUser, "cover-letters")`, then zod:
  `z.string().trim().max(MAX_INSTRUCTIONS_CHARS)` / `.max(MAX_EXAMPLE_LETTER_CHARS)`, then
  `saveCoverLetterInstructions`. Over-cap gets its own message naming the count and the limit —
  never a silent trim.
- `importExampleLetter` — takes a document id + extension, reuses `listDocuments()`
  (`lib/documents/list-documents.ts`) to confirm the object is the caller's and is readable,
  `resumes.get()`, then `extractProfileText()` (`lib/cover-letters/profile-text.ts`, already handles
  `.md`/`.txt`/PDF/DOCX and throws `ProfileTextError` for everything else). Writes the extracted
  text to `exampleLetter`, leaving `instructions` as-is. Refuses over `MAX_EXAMPLE_LETTER_CHARS`
  rather than trimming, naming the document.

Wrapper `app/(app)/settings/actions.ts` gains `saveLetterInstructionsAction` and
`importExampleLetterAction`, each `refresh()`ing on success — mandatory here because
`staleTimes.dynamic: 30` would otherwise serve the pre-save text back on the next visit.

## 5. UI — a third section on `/settings`

`components/settings/cover-letter-section.tsx` (server component, mirrors `briefing-section.tsx`):
reads the row and `listDocuments()`, passes plain strings across the client boundary — no `Date`.

```
── Cover letters ────────────────────────────────
Applied to every letter, on top of the rules below.

▸ What the writer always does          (disclosure)

Your instructions
┌──────────────────────────────────────────────┐
│ Never use the word "passionate".             │
│ Open with why the role. Australian spelling. │
└──────────────────────────────────────────────┘
                                    412 / 2,000

Example letter                          optional
┌──────────────────────────────────────────────┐
│ Dear Hiring Team, …                          │
└──────────────────────────────────────────────┘
                                  1,204 / 6,000
Voice and structure are copied from this. Facts never are.

[ Save instructions ]

Or fill it from a document you have uploaded.
Replaces what is in the box above.
[ letter-acme.docx · Cover letter  ▾ ] [ Fill from document ]
```

- `letter-instructions-form.tsx` — `"use client"`, `useActionState` + `<form action={formAction}>`,
  two `Textarea`s from `@workspace/ui/components/textarea` (it is `field-sizing-content`, so give
  the example one a `min-h-64`), `SubmitButton`, `ActionAlert`. **Not** keyed on `resetKey` — it
  shows a current value, so it follows `job-schedule-form.tsx`, not `create-briefing-form.tsx`.
- Live counters via a small `useState` per field, muted below the cap and destructive above it.
  **No `maxLength`** — browsers truncate a paste against it silently, which is the exact failure
  this codebase refuses; the cap is enforced server-side with a message that says the numbers.
- `example-letter-import.tsx` — a separate `<form>` so it posts on its own. Radix `Select` plus a
  hidden input, exactly as `interval-field.tsx` documents (a Radix Select renders a button, so its
  value never reaches `FormData` on its own). List every readable Document newest-first with its
  Document Type as the label.
- The disclosure renders `COVER_LETTER_WRITER_SYSTEM_PROMPT` split on blank lines. Rendering the
  real constant rather than a hand-written summary is what stops the two drifting.
- `/briefings`, beside the cover-letter list: one line linking to `/settings` — the knob and the
  Draft button are on different pages, and nothing else would tell you the knob exists.

## 6. Tests

- `packages/agents/src/cover-letter-writer.test.ts` — empty extras give a byte-identical base
  prompt; instructions and example appear verbatim; the example carries the "take no fact from it"
  sentence; the precedence paragraph precedes both.
- `packages/db/src/stores.test.ts` — first save creates the row, second updates it, read of a user
  with no row is `undefined`. Needs a real database; skips without `DATABASE_URL_UNPOOLED`, so run
  it in CI, and run it through Turborepo (`pnpm turbo test --filter=@workspace/db`) because
  `generate` is a task dependency.
- New `apps/dashboard/lib/cover-letters/letter-instructions-actions.test.ts` — follow
  `job-actions.test.ts` (`vi.hoisted` mocks over `@workspace/db`, `SIGNED_IN`/`REFUSED`/`ANONYMOUS`
  fixtures, injected `newResetKey`): anonymous is refused before the body is read; over-cap is
  refused with the count; import extracts and stores; import of another user's document is refused;
  a `ProfileTextError` becomes a message, not a throw.
- `cover-letter-actions.test.ts` — the saved instructions reach the writer (assert on the composed
  `systemPrompt` via the fake), and a throwing instructions read fails the draft rather than
  drafting without them.

## 7. Docs

`CONTEXT.md` gains a **Letter Instructions** entry — per-user, extends the Letter Writer's prompt,
never overrides its honesty rules; the example letter is a style reference and never a source of
facts. `OVERVIEW.md` §Not built yet: strike "regenerate it with instructions, choose a tone" and
leave rendering, editing and sending. `packages/db/README.md` gains the new module and notes the
one `Cascade` and why.

---

## Verification

```bash
pnpm build                                    # ordered by Turbo's ^build
pnpm typecheck                                # both halves in the emitting packages
pnpm test                                     # agents, db, dashboard
DATABASE_URL_UNPOOLED=… pnpm --filter @workspace/db migrate
```

No Terraform and no IAM change: nothing new is stored in S3, and the import path reads the
`prod:resumes` grant the dashboard already holds.

**Most of this is verifiable with no database and no credentials.** `DEV_AUTH_BYPASS=1` in
`apps/dashboard/.env.local` serves every page from fixtures through a fake Prisma client and fake
stores. That fake **throws by name on any query it does not implement**, so the new model must be
added to it and to the fixtures as part of the first slice — otherwise the Settings section
throws the moment it reads. Only the real migration and a real drafted letter need live
infrastructure.

End to end, once migrated and running `pnpm turbo dev --filter=@workspace/dashboard`:

1. `/settings` → Cover letters. Save `Never use the word "passionate". Sign off "Kind regards".`
2. Reload the page — the text is still there. That is the "save it and edit it later" claim.
3. `/briefings` → **Draft cover letter** on a Posting. Download it from the list and confirm the
   sign-off changed and the word is absent.
4. Paste an example letter containing a fact that is **not** in the uploaded CV — a made-up
   employer. Redraft. The letter should pick up the sample's register and must not claim that
   employer. This is the check the split fields exist for; if it fails, the fencing needs work
   before anything else.
5. Upload a `.docx` letter under `/documents`, then **Fill from document** — the textarea fills
   with its text. Save, redraft, confirm.
6. Clear both fields and save. Drafting returns to the built-in behaviour, and the composed prompt
   is byte-identical to the constant.
7. Paste 7,000 characters into the example field. Saving is refused with a message naming the
   count and the limit, and nothing is silently trimmed.
