"use client"

import { useActionState, useState } from "react"
import { ActionAlert } from "@/components/forms/action-alert"
import { SubmitButton } from "@workspace/ui/components/submit-button"

import { saveLetterInstructionsAction } from "@/app/(app)/jobs/letters/actions"
import { IDLE } from "@/lib/actions/action-state"
import {
  MAX_EXAMPLE_LETTER_CHARS,
  MAX_INSTRUCTIONS_CHARS,
} from "@workspace/agents/cover-letter"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"

/**
 * What the candidate has saved about how their letters should be written.
 *
 * Both fields save together — one row, one setting, one button — so an empty
 * example letter posted alongside filled-in instructions genuinely means "no
 * example", rather than "this form did not mention it".
 *
 * The caps come from `@workspace/agents/cover-letter`, which is the same module
 * the save action validates against. Restating 2,000 and 6,000 here would let
 * the counter go green on text the server then refuses.
 */
export function LetterInstructionsForm({
  instructions,
  exampleLetter,
}: {
  instructions: string
  exampleLetter: string
}) {
  const [state, formAction, pending] = useActionState(
    saveLetterInstructionsAction,
    IDLE
  )

  return (
    <form
      action={formAction}
      className="flex flex-col gap-6 rounded-lg border p-4"
    >
      {/*
        Neither field is keyed on the reset key, unlike the create-briefing
        form. They hold a current value rather than a blank slate, so a success
        must leave them showing what was just saved — clearing them would read
        as the save having thrown the text away.
      */}
      <InstructionsField value={instructions} pending={pending} />

      {/*
        ⚠️ **Only the example is keyed, and only on the stored value.** A
        textarea is uncontrolled, so without this an import would land in the
        database and look like it had done nothing. On this field alone, because
        a remount discards the box: keying both would make importing an example
        silently revert unsaved edits to the instructions above it.
      */}
      <ExampleField
        key={`example:${exampleLetter}`}
        value={exampleLetter}
        pending={pending}
      />

      <div>
        <SubmitButton
          pending={pending}
          label="Save instructions"
          pendingLabel="Saving…"
        />
      </div>

      <ActionAlert state={state} />
    </form>
  )
}

/**
 * ⚠️ **No `maxLength` on either field.** A browser truncates a paste against
 * `maxLength` silently, so the user sees a full-looking box, saves, and loses
 * the tail with nothing saying so. The cap is enforced server-side where it can
 * be refused out loud. The counters below warn; they do not enforce.
 */
function InstructionsField({
  value,
  pending,
}: {
  value: string
  pending: boolean
}) {
  const [count, setCount] = useState(() => countOf(value))

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="letter-instructions">Your instructions</Label>
      <Textarea
        id="letter-instructions"
        name="instructions"
        defaultValue={value}
        onChange={(event) => setCount(countOf(event.target.value))}
        placeholder={
          'Never use the word "passionate". Open with why the role. Australian spelling.'
        }
        disabled={pending}
        className="min-h-32"
      />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Applied to every letter, on top of the built-in rules. Tone, length,
          structure, salutation, what to emphasise, what to avoid.
        </p>
        <CharacterCount count={count} max={MAX_INSTRUCTIONS_CHARS} />
      </div>
    </div>
  )
}

function ExampleField({ value, pending }: { value: string; pending: boolean }) {
  const [count, setCount] = useState(() => countOf(value))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="letter-example">Example letter</Label>
        <span className="text-sm text-muted-foreground">optional</span>
      </div>
      <Textarea
        id="letter-example"
        name="exampleLetter"
        defaultValue={value}
        onChange={(event) => setCount(countOf(event.target.value))}
        placeholder="Dear Hiring Team, …"
        disabled={pending}
        // `field-sizing-content` grows the box to whatever is in it; this is
        // the floor, so an empty example still looks like somewhere a letter
        // goes rather than a one-line input.
        className="min-h-64"
      />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/*
          Said plainly because the alternative is a user pasting someone else's
          letter and expecting its facts to be adapted to them. Voice is copied;
          claims are not, and the writer is told so in as many words.
        */}
        <p className="text-sm text-muted-foreground">
          Voice and structure are copied from this.{" "}
          <strong className="font-medium text-foreground">
            Facts never are
          </strong>{" "}
          — no employer, role, date or number in it is treated as yours.
        </p>
        <CharacterCount count={count} max={MAX_EXAMPLE_LETTER_CHARS} />
      </div>
    </div>
  )
}

/**
 * The number of characters that would actually be stored.
 *
 * ⚠️ Trimmed, because `saveSchema` in `letter-instructions-actions.ts` trims
 * before it measures — a counter over raw `value.length` turns red on a paste
 * with a trailing newline the server then accepts without complaint.
 */
function countOf(value: string): number {
  return value.trim().length
}

/**
 * A fixed locale, not the runtime's.
 *
 * ⚠️ `toLocaleString()` with no locale reads the server's default on first
 * render and the browser's on hydration, which React reports as a hydration
 * mismatch — the same trap `briefing-summary.ts` names for dates.
 */
const COUNT_FORMAT = new Intl.NumberFormat("en-AU")

function CharacterCount({ count, max }: { count: number; max: number }) {
  // Strictly over, not at. The server's `.max()` accepts a value exactly on the
  // cap, so turning red there would refuse in the UI what the action saves
  // without complaint.
  const overLimit = count > max

  return (
    <p
      className={cn(
        "text-sm tabular-nums",
        overLimit ? "text-destructive" : "text-muted-foreground"
      )}
      role="status"
      aria-live="polite"
    >
      {COUNT_FORMAT.format(count)} / {COUNT_FORMAT.format(max)}
    </p>
  )
}
