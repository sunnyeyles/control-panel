# 01 — Saved instructions that change how letters are written

**What to build:** The user opens Settings, finds a **Cover letters** section, and types
instructions for the **Letter Writer** — things like _"never use the word 'passionate'"_ or
_"sign off with Kind regards"_. They save. They come back a day later and the text is still
there, ready to edit. When they draft a **Cover Letter** from a **Posting**, the letter obeys
what they wrote.

Above the field, a disclosure shows the rules the writer always follows regardless — so the
user is extending something visible rather than guessing what is already covered. It renders
the writer's real system prompt, not a hand-written summary, so the two cannot drift.

The instructions **extend** the writer's prompt; they never replace it. They may change tone,
length, structure, salutation, emphasis and vocabulary. They may not license a claim the
candidate's background does not support, and may not remove a `[bracketed placeholder]`. Where
they conflict, the built-in rules win.

Nothing per-user is stored in Postgres today — `users` carries identity and nothing else — so
this ticket introduces the row. It belongs in its own table rather than as columns on `users`:
that table is the platform identity referenced by `jobs.user_id` and used as the `userId`
segment of every object key, and it deliberately carries nothing beyond that.

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

`example_letter` lands in this migration but stays unused until ticket 02 — one forward-only
migration is cheaper than two, and migrations here are never reversed.

`onDelete: Cascade` is the one deliberate exception to this repo's `Restrict` rule: the row is
a preference with no independent existence, not a record that something happened, and
`Restrict` would make a user undeletable for the sake of a settings row. Say so in the schema
comment and in the package README.

A failed read of the instructions **fails the draft** rather than drafting without them.
Drafting silently without the user's rules produces a letter that looks perfect and ignores
every one of them — the same silent-failure shape that makes a run with no successful search
fail.

Over-length text is refused at save time with a message naming the count and the limit. Never
trimmed, and no `maxLength` on the field — browsers truncate a paste against `maxLength`
silently, which is exactly the failure being avoided.

This adds a fifth copy of the app's Server Action scaffolding pattern. That is deliberate and
noted — #104 exists to collapse all of them, and its interface is not designed yet, so this
does not wait on it.

**The dev bypass has to learn about the new model.** Under `DEV_AUTH_BYPASS=1` the app is served
from a fake Prisma client that **throws by name on any query it does not implement** — a
deliberate choice, so a missing delegate is loud rather than silently `undefined`. A new model
read by the settings page and the draft action therefore breaks dev mode until the fake and its
fixtures cover it. Teaching it is part of this ticket, not a follow-up, and it is also what makes
the whole feature verifiable locally with no database, no AWS credentials and no OAuth round
trip.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A migration adds the table; `pnpm --filter @workspace/db migrate` applies cleanly against
      the direct endpoint, and the schema comment records why the cascade is there
- [ ] Domain helpers read and upsert a user's instructions, exported from the db package and
      following its free-function-taking-the-client shape
- [ ] A pure prompt composer in the agents package appends the instructions to the writer's
      system prompt behind a precedence paragraph; it needs no API key to test
- [ ] With no instructions saved, the composed prompt is **byte-identical** to the existing
      constant — asserted, not assumed
- [ ] The Settings page shows a Cover letters section with an instructions field, a live
      character count that turns destructive past the cap, and a save button
- [ ] Saving persists; reloading the page shows the saved text; editing and saving again
      replaces it
- [ ] A disclosure renders the writer's actual system prompt so the fixed rules cannot drift
      from what is displayed
- [ ] Drafting a cover letter obeys a saved instruction — verified end to end with a real draft
- [ ] Text over the cap is refused with a message naming the count and the limit; nothing is
      silently trimmed
- [ ] A failed instructions read fails the draft rather than drafting without them
- [ ] An unauthenticated POST to the save action is refused before the body is read
- [ ] The dev fake Prisma and its fixtures cover the new model, so the Settings section renders
      and saves under `DEV_AUTH_BYPASS=1` with no database — and the fake still throws by name
      on anything it does not implement
- [ ] Tests cover the composer, the db helpers, and the action's auth and validation branches
- [ ] `CONTEXT.md` gains a glossary entry for the new term, stating that instructions never
      override the writer's honesty rules
