import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { POSTING_NOT_FOUND } from "@/lib/actions/not-found"
import { requireUser } from "@/lib/actions/require-user"
import { storageMessage } from "@/lib/actions/storage-message"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  loadCandidateBackground,
  type NoBackgroundReason,
} from "@/lib/candidate/candidate-background"
import { POSTING_ID_PATTERN } from "@/lib/posting-documents/posting-document-ref"
import {
  loadStoredPosting,
  storedPostingMessage,
} from "@/lib/postings/load-stored-posting"
import type { Agent } from "@workspace/agents"
import {
  assertDraftable,
  CoverLetterRequestSchema,
  toCoverLetterPrompt,
  UndraftableError,
  type CoverLetterRequest,
  type LetterInstructions,
} from "@workspace/agents/cover-letter"
import {
  coverLetterSystemPrompt,
  createCoverLetterWriter,
} from "@workspace/agents/cover-letter-writer"
import { coverLetterInstructions, type PrismaClient } from "@workspace/db"
import { createLangfuseCallback } from "@workspace/langfuse"
import {
  isUserStorageError,
  type CoverLetterStore,
  type ResumeStore,
  type StoredCoverLetter,
} from "@workspace/user-storage"
import { z } from "zod"

/**
 * Drafting one cover letter for one Posting, as plain functions over injected
 * dependencies.
 *
 * **Nothing in this file imports Next**, which is the whole reason the security
 * branches can be tested: every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/jobs/actions.ts`, which is `"use server"`, supplies the real
 * dependencies, and calls `refresh()`.
 *
 * Three properties this module exists to hold, each of which would be invisible
 * if it were satisfied only by the current call site:
 *
 * 1. **The form carries one identifier, never a Posting.** A Posting arriving
 *    in form data would let a caller put text of their choosing into a stored
 *    document written in the user's voice — and it would break *copied, never
 *    composed* at the last step of the chain that maintains it. The Posting is
 *    re-read server-side out of the stored row's `payload` — the validated
 *    advertisement as its producer wrote it, which nothing on the client can
 *    write. `cover-letter-actions.test.ts` submits a `posting` field and
 *    asserts it changes nothing.
 * 2. **The Posting is addressed by (session user, posting id), so there is no
 *    ownership to assume.** `(user_id, posting_id)` is the natural key of
 *    `postings` and the user half comes from the session, so a stranger's
 *    advertisement cannot be *named* from here rather than being named, loaded,
 *    and then refused by a comparison somebody has to remember to write. There
 *    is no Run in the path at all, and no window between a check and a read.
 * 3. **The storage key is built from the session's user id.** Nothing from the
 *    form reaches the `userId` segment, so `assertSegment` in
 *    `@workspace/user-storage` is a second line of defence rather than the only
 *    one.
 *
 * Properties 1 and 2 are held by `lib/postings/load-stored-posting.ts`, which
 * this file used to contain and which the tailored-resume actions now share —
 * including why the Posting is read from `postings.payload` and never from
 * `runs.findings`. The reasoning lives there; what stays here is that this
 * action passes it one identifier out of the form and the caller's own id, and
 * nothing else.
 *
 * The candidate's saved instructions extend that first property rather than
 * qualifying it. They are read from the database, keyed on the session's user
 * id, and there is deliberately **no form field for them** — one would be a
 * second way to put text of the caller's choosing into the system prompt of an
 * agent holding the user's CV, which is exactly what re-reading the Posting
 * server-side exists to prevent.
 *
 * And one that is about spending rather than security: the refusal for "no
 * readable CV" happens **before** the writer is constructed, so a user with
 * nothing to write from costs no model call. That is the same rule as
 * `assertDraftable`, one step earlier.
 */

/**
 * One message for "no such Posting" and "someone else's Posting".
 *
 * Re-exported from `lib/actions/not-found.ts` so posting-actions and tests share
 * one string. The two cases are indistinguishable to this action by construction —
 * the lookup names the caller as half its key — and that identity is load-bearing:
 * Posting ids are derived from an advertisement's URL, so two messages would turn
 * a form into an oracle for whether a stranger has been shown it.
 */
export { POSTING_NOT_FOUND }

/** Reachable only by posting a form directly; the buttons always send it. */
const BAD_REQUEST = "That posting could not be identified."

/**
 * The Posting id shape, from `lib/posting-documents/posting-document-ref.ts`.
 *
 * It lived here until the download route needed the same rule, and moved again
 * once the tailored resume turned out to be addressed by the same value; the
 * reasoning for why it is restated at all rather than exported from
 * `@workspace/agents` moved with it. One copy, because it is what makes every
 * value reaching the store a legal key segment by construction.
 *
 * ⚠️ **This is now {@link saveSchema} without its `markdown`, and that is the
 * two actions agreeing rather than a duplication to collapse.** A letter is
 * addressed by `(user, Posting)` however it came to be written, so each action
 * asks for exactly one identifier. Sharing one schema would tie what a draft
 * accepts to what an edit accepts, which is the pair most worth leaving free to
 * diverge: one of them takes letter text from the caller, and the other must
 * never.
 */
const draftSchema = z.object({
  postingId: z.string().regex(POSTING_ID_PATTERN),
})

/**
 * There is no letter at that address to edit.
 *
 * ⚠️ **This refusal is the security property of {@link
 * createCoverLetterActions.saveCoverLetter}, not a convenience.** Drafting
 * deliberately never accepts letter text from a form — see property 1 above —
 * because text taken from a form would become arbitrary content inside a
 * document stored in the user's own voice. Saving *does* accept text, which is
 * safe only for as long as it can nothing but overwrite a letter the caller
 * already has. Requiring the object to exist is what holds that line: without
 * it, a caller could spell any well-formed Posting id and mint a letter of
 * their choosing at it.
 *
 * It is also the "not yours" answer, which is the same conflation the download
 * route makes: the key is built from the session's user, so another user's
 * letter is not merely refused here — it cannot be addressed at all, and what
 * the caller sees is an empty prefix.
 */
export const LETTER_NOT_FOUND =
  "There is no drafted cover letter for that posting. Draft one before editing it."

/**
 * The longest letter that can be saved.
 *
 * The drafting path needs no such bound because a model wrote the bytes and its
 * own output limit is the ceiling. Here a person does, through a rich-text
 * editor that will paste whatever is on a clipboard, so the bound is this
 * side's job. Generous by the standards of a cover letter — a long one is a
 * couple of thousand characters — because refusing a legitimate letter is worse
 * than storing a silly one, and the object store is not the thing under
 * pressure.
 */
export const MAX_LETTER_CHARS = 50_000

/** Nothing survived the trim. */
const EMPTY_LETTER = "There is nothing to save — the letter is empty."

const LETTER_TOO_LONG = `That letter is too long to save. The limit is ${MAX_LETTER_CHARS.toLocaleString("en-AU")} characters.`

/**
 * ⚠️ **`markdown` is bounded below, not here.** A `.max()` on the schema would
 * report a 60,000-character letter with the same message as a missing field,
 * and the two are nothing alike from the user's side.
 */
const saveSchema = z.object({
  postingId: z.string().regex(POSTING_ID_PATTERN),
  markdown: z.string(),
})

export interface CoverLetterActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * The client, resolved per call rather than held — so the factory constructs
   * nothing at module scope and cannot throw at import time on a missing
   * `DATABASE_URL`. Same for the two stores below.
   */
  getPrisma: () => PrismaClient
  /** Where the candidate's own document is read from. */
  getResumes: () => ResumeStore
  /** Where the drafted letter is written. */
  getCoverLetters: () => CoverLetterStore
  /**
   * The writer. Defaults to the real agent, which reads `OPENAI_API_KEY` when
   * constructed — hence a factory called inside the action, never at module
   * scope. A test passes one built over a fake chat model.
   *
   * Takes the candidate's saved instructions, because the system prompt is
   * composed from them and an agent is built per draft anyway. The composition
   * is `coverLetterSystemPrompt`'s, not this file's: what a test injected here
   * asserts on is *which* prompt was composed, which is the only part that can
   * be got wrong from this side.
   */
  createWriter?: (extras: LetterInstructions) => Agent
  /** Overridden in tests, so an assertion can name the drafting instant. */
  now?: () => Date
  /** Overridden in tests, so an assertion can name the reset key. */
  newResetKey?: () => string
}

export function createCoverLetterActions(deps: CoverLetterActionsDeps) {
  const createWriter =
    deps.createWriter ??
    ((extras: LetterInstructions) =>
      createCoverLetterWriter({
        systemPrompt: coverLetterSystemPrompt(extras),
      }))
  const now = deps.now ?? (() => new Date())
  const newResetKey = deps.newResetKey ?? (() => crypto.randomUUID())

  async function draftCoverLetter(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    // Before the body is touched at all. For a Server Action this is not a
    // second layer: `proxy.ts` cannot evaluate a POST session — the auth SDK's
    // fast path is guarded by `method === "GET"` — so it degrades to checking
    // that some session-cookie substring is present. This is the only real
    // check on the path.
    const caller = await requireUser(deps.getUser, "cover-letters")
    if (!caller.ok) return fail(caller.message)

    // ⚠️ **Only this one field is read, and that is the security property.**
    // `formData` may well carry a `posting` — the test suite submits one — and
    // nothing here looks at it. A Posting body accepted from a form would be
    // arbitrary text stored in a document written in the user's voice.
    const parsed = draftSchema.safeParse({
      postingId: formData.get("postingId"),
    })

    if (!parsed.success) return fail(BAD_REQUEST)

    const stored = await loadStoredPosting(
      deps.getPrisma(),
      caller.userId,
      parsed.data.postingId,
      "cover-letters"
    )
    if (stored.status !== "found") return fail(storedPostingMessage(stored))

    const { posting, lastSeenRunId } = stored

    // Before the writer is constructed, so a user with nothing to write from
    // spends nothing. Since #86 this is also where a PDF or a DOCX is parsed —
    // still on this side of the model call, which is what keeps the bounds
    // below applying to the text that was actually extracted.
    let background
    try {
      background = await loadCandidateBackground(
        caller.userId,
        deps.getPrisma(),
        deps.getResumes()
      )
    } catch (error) {
      return fail(storageMessage(`cover-letters: read failed`, error))
    }

    if (!background.ok)
      return fail(describeMissingBackground(background.reason))

    let request: CoverLetterRequest
    try {
      // Still before the model call, and measured on the *extracted* text: a
      // letter written from too little is not a thin letter, it is a fabricated
      // one, and every specific in it would be invented and then attributed to
      // the user.
      assertDraftable({ background: background.background })

      request = CoverLetterRequestSchema.parse({
        posting,
        profile: { background: background.background },
      })
    } catch (error) {
      if (error instanceof UndraftableError) {
        return fail(describeUndraftable(error, background.displayName))
      }

      console.error("cover-letters: the request would not validate", error)
      return fail("That posting could not be turned into a letter.")
    }

    // ⚠️ **A failed read fails the draft — it never drafts without them.**
    // Drafting anyway produces a letter that looks perfect and quietly ignores
    // every rule the user wrote: the sign-off they asked for is missing, the
    // word they banned is back, and nothing anywhere says why. That is the same
    // silent-failure shape `assertDraftable` refuses one step earlier, and the
    // reason the failure is loud here rather than degraded to the built-in
    // behaviour.
    //
    // A user with *no row* is a different thing and is the ordinary case: they
    // never opened Settings, `coverLetterSystemPrompt` composes byte-identically
    // to the constant, and the draft proceeds.
    let extras: LetterInstructions
    try {
      const saved = await coverLetterInstructions(
        deps.getPrisma(),
        caller.userId
      )

      extras = {
        instructions: saved?.instructions ?? "",
        exampleLetter: saved?.exampleLetter ?? "",
      }
    } catch (error) {
      console.error("cover-letters: could not read the instructions", error)
      return fail("Something went wrong.")
    }

    let markdown: string
    try {
      markdown = await draft(request, caller.userId, extras)
    } catch (error) {
      console.error("cover-letters: the writer failed", error)
      return fail("The letter could not be drafted. Try again in a moment.")
    }

    try {
      await deps.getCoverLetters().put({
        // ⚠️ **The session's userId, never anything from the form.** There is
        // no way to *name* another user's prefix from here, which is what makes
        // the key-segment assertion in the store a second line of defence.
        userId: caller.userId,
        postingId: parsed.data.postingId,
        markdown,
        draftedAt: now(),
        // Provenance rides here rather than in the key — the key holds the
        // Posting id and nothing else, so a redraft overwrites one object. Each
        // value is model-copied text and is stripped to what an HTTP header can
        // carry by the store; see `toMetadataRecord`.
        provenance: {
          // The Run that most recently reported this advertisement, carried
          // off the row rather than looked up. Provenance exactly as it was
          // when this action read a Run directly — "which Run found this" is
          // worth keeping, and it is still no part of the key.
          runId: lastSeenRunId,
          title: posting.title,
          company: posting.company,
          url: posting.url,
        },
      })
    } catch (error) {
      return fail(storageMessage(`cover-letters: write failed`, error))
    }

    return {
      status: "success",
      message: `Drafted a cover letter for ${posting.title} at ${posting.company}. It is a first draft to edit — anything nobody supplied is left as a [bracketed placeholder].`,
      // A fresh value per success rather than the posting id: a redraft of the
      // same Posting is a second success and must read as one.
      resetKey: newResetKey(),
    }
  }

  /**
   * Create a manually written cover letter for one owned Posting.
   *
   * Unlike {@link saveCoverLetter}, this is allowed to write the first object
   * at an address. It earns that privilege by re-reading the Posting under the
   * session's user id, so a direct POST cannot mint a letter for an arbitrary
   * key or supply provenance from the browser. There is no model call and no
   * candidate-background read: the editor contains the user's own words.
   */
  async function createCoverLetter(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    const caller = await requireUser(deps.getUser, "cover-letters")
    if (!caller.ok) return fail(caller.message)

    const parsed = saveSchema.safeParse({
      postingId: formData.get("postingId"),
      markdown: formData.get("markdown"),
    })
    if (!parsed.success) return fail(BAD_REQUEST)

    const markdown = parsed.data.markdown.replace(/\r\n/g, "\n").trim()
    if (markdown.length === 0) return fail(EMPTY_LETTER)
    if (markdown.length > MAX_LETTER_CHARS) return fail(LETTER_TOO_LONG)

    const stored = await loadStoredPosting(
      deps.getPrisma(),
      caller.userId,
      parsed.data.postingId,
      "cover-letters"
    )
    if (stored.status !== "found") return fail(storedPostingMessage(stored))

    const ref = { userId: caller.userId, postingId: parsed.data.postingId }
    const letters = deps.getCoverLetters()

    try {
      await letters.head(ref)
      return fail(
        "A cover letter already exists for that posting. Edit it instead."
      )
    } catch (error) {
      if (!isUserStorageError(error) || error.code !== "object_not_found") {
        return fail(storageMessage(`cover-letters: read failed`, error))
      }
    }

    try {
      await letters.put({
        ...ref,
        markdown,
        draftedAt: now(),
        provenance: {
          runId: stored.lastSeenRunId,
          title: stored.posting.title,
          company: stored.posting.company,
          url: stored.posting.url,
        },
      })
    } catch (error) {
      return fail(storageMessage(`cover-letters: write failed`, error))
    }

    return {
      status: "success",
      message: `Created a cover letter for ${stored.posting.title} at ${stored.posting.company}.`,
      resetKey: newResetKey(),
    }
  }

  /**
   * Save an edited letter over the stored one.
   *
   * The counterpart to {@link draftCoverLetter}, and deliberately a different
   * shape: **no model.** It read "no Run, no Findings, no model" until drafting
   * moved to the stored Posting's `payload` — the draft action names neither a
   * Run nor Findings now either, so the model call is the one of the three
   * still telling them apart. A letter is addressed by `(user, Posting)` and
   * the caller is editing something that already exists,
   * so the Run that found the Posting is neither needed nor asked for — it is
   * already recorded in the letter's own provenance, and that is where it stays.
   *
   * Three things this holds, in order:
   *
   * 1. **Who is asking, before the body is touched.** Same reasoning as the
   *    draft action: for a Server Action `proxy.ts` cannot evaluate the session
   *    on a POST, so this is the only real check.
   * 2. **The letter must already exist** — see {@link LETTER_NOT_FOUND}, which
   *    is where the reasoning lives, because it is the property that keeps an
   *    action accepting letter text from being a way to create one.
   * 3. **`draftedAt` and provenance are carried across, never restamped.** An
   *    edit is not a drafting. The Posting card renders "Cover letter drafted
   *    <date>", and the letters list renders the title and company out of
   *    provenance — a save that dropped either would have the page report that
   *    the model rewrote the letter just now, or blank a row down to a hex
   *    digest.
   */
  async function saveCoverLetter(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    const caller = await requireUser(deps.getUser, "cover-letters")
    if (!caller.ok) return fail(caller.message)

    const parsed = saveSchema.safeParse({
      postingId: formData.get("postingId"),
      markdown: formData.get("markdown"),
    })

    if (!parsed.success) return fail(BAD_REQUEST)

    // Normalized before it is measured and before it is stored. Two separate
    // reasons:
    //
    // ⚠️ **`\r\n` is for the POST, not for the editor — nothing the UI does can
    // produce it.** ProseMirror normalizes `\r\n` to `\n` as it parses the
    // clipboard, so a letter pasted out of a Windows editor is already LF before
    // it is a document; Turndown then emits LF, which
    // `packages/ui/src/lib/markdown.test.ts` pins. Both halves of the only path
    // a user has are covered, and this line is unreachable through it.
    //
    // It stays because a Server Action is reachable by direct POST with a
    // FormData nobody typed — see `apps/dashboard/CLAUDE.md` — and the store is
    // told `text/markdown`. Cheaper to normalize than to reason about later.
    // Do not read it as evidence the editor emits CRLF; two comments here have
    // now claimed a source for it that does not hold.
    //
    // ⚠️ **Line endings are the only normalization this side does, and the
    // larger half is not here.** Whether an *unedited* save is a no-op depends
    // on the markdown dialect the editor round-trips through, which is fixed in
    // `createMarkdownSerializer()` and asserted there. This action cannot check
    // it: by the time the bytes arrive they are already serialized.
    //
    // `trim()` because a letter that is only whitespace is an empty one however
    // much of it there is, and Turndown leaves a trailing newline on nearly
    // everything.
    const markdown = parsed.data.markdown.replace(/\r\n/g, "\n").trim()

    if (markdown.length === 0) return fail(EMPTY_LETTER)
    if (markdown.length > MAX_LETTER_CHARS) return fail(LETTER_TOO_LONG)

    const letters = deps.getCoverLetters()

    // ⚠️ **The session's userId, never anything from the form** — the same rule
    // as the draft action, and the reason a request naming another user's
    // letter cannot be spelled rather than merely being refused.
    const ref = { userId: caller.userId, postingId: parsed.data.postingId }

    let existing: StoredCoverLetter
    try {
      existing = await letters.head(ref)
    } catch (error) {
      if (
        isUserStorageError(error) &&
        (error.code === "object_not_found" ||
          error.code === "object_ownership" ||
          error.code === "invalid_object_key")
      ) {
        return fail(LETTER_NOT_FOUND)
      }

      // Anything else is the bucket being unreachable, which must not be
      // reported as "you have not drafted this" — that would tell a user their
      // letter is gone during an outage.
      return fail(storageMessage(`cover-letters: read failed`, error))
    }

    try {
      await letters.put({
        ...ref,
        markdown,
        draftedAt: existing.draftedAt,
        provenance: existing.provenance,
      })
    } catch (error) {
      return fail(storageMessage(`cover-letters: write failed`, error))
    }

    return {
      status: "success",
      message: "Saved your changes to this cover letter.",
      resetKey: newResetKey(),
    }
  }

  /**
   * One model call, traced.
   *
   * ⚠️ **The callback is not optional decoration.** Every other agent run in
   * this repository reports to Langfuse — `generate-briefing` from the worker,
   * `chat-response` from the dashboard — and one that did not would be the only
   * agent invocation whose prompt and output nobody can inspect after the fact,
   * which for a document written in the user's own voice is the worst place to
   * lose the transcript. The shape is `lib/chat-handler.ts`'s: a handler per
   * invocation (they retain run state, so sharing one would mix traces),
   * `langfuseUserId`/`langfuseSessionId` in metadata, and the callback spread in
   * only when Langfuse is configured — it is `undefined` without keys, and
   * `callbacks: [undefined]` is not the same as no callbacks.
   *
   * `.invoke()` rather than `.stream()`: the writer has no tools, so the graph
   * is START → model → END and there are no intermediate steps for a stream to
   * be interesting about. The `letter` CLI makes the same call for the same
   * reason.
   */
  async function draft(
    request: CoverLetterRequest,
    userId: string,
    extras: LetterInstructions
  ): Promise<string> {
    const writer = createWriter(extras)
    const sessionId = crypto.randomUUID()

    const callback = createLangfuseCallback({
      userId,
      sessionId,
      tags: ["dashboard", "cover-letter"],
      traceMetadata: {
        feature: "cover-letter",
        route: "/jobs",
      },
    })

    const result = await writer.invoke(
      { messages: [{ role: "user", content: toCoverLetterPrompt(request) }] },
      {
        runName: "cover-letter",
        metadata: {
          langfuseUserId: userId,
          langfuseSessionId: sessionId,
        },
        ...(callback ? { callbacks: [callback] } : {}),
      }
    )

    const letter = result.messages.at(-1)?.text.trim() ?? ""

    if (letter.length === 0) {
      throw new Error("The writer returned an empty letter.")
    }

    return letter
  }

  return { createCoverLetter, draftCoverLetter, saveCoverLetter }
}

/**
 * Why there is nothing to write from, as something to act on.
 *
 * Every message names formats outright. That is a requirement rather than
 * helpfulness: `resumes` accepts more on upload than anything can read, so a
 * user is being refused a document the app already took, and without the
 * sentence the refusal reads as a bug.
 *
 * ⚠️ **The `.doc`, `.odt` and `.rtf` sentence is not a leftover.** #86 taught
 * this app to read a PDF and a DOCX, and the "upload it as .md or .txt instead"
 * line went with it — but only for those two. Those three extensions are still
 * accepted on upload and still have no parser, so deleting the refusal wholesale
 * would have replaced an over-broad message with an absent one.
 */
function describeMissingBackground(reason: NoBackgroundReason) {
  switch (reason) {
    case "no-resume":
      return "No resume to write from. Upload your CV under Documents and label it Resume — a PDF, a Word .docx, or a .md or .txt file."

    case "unreadable-format":
      return "Your resume is a .doc, .odt or .rtf file, and reading those is not built yet. Save the same CV as a PDF, a Word .docx, or a .md or .txt file, upload it labelled Resume, and try again."

    case "extraction-failed":
      // Deliberately silent about which parser failed and why: pdf.js and jszip
      // both throw about internal structure, and neither sentence helps the
      // person holding the CV. The detail is in the server log.
      return "Your resume could not be read. The file may be damaged, or not really the format its name says — and a PDF that is a scan of a printed page has no text in it to extract. Try re-exporting it, or upload the CV as a .md or .txt file."

    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

/**
 * The three ways a document can be present and still not be writable from.
 *
 * ⚠️ **These bounds are measured on the *extracted* text, not on the file.** A
 * 200 KB PDF whose text layer is a name and a phone number is `too-short`, and
 * an eight-page CV is `too-long` however small the DOCX compresses to. Since
 * #86 that is the only reading of them that makes sense, and it is why
 * `loadCandidateBackground` extracts before `assertDraftable` runs rather than
 * the other way round.
 */
function describeUndraftable(error: UndraftableError, displayName: string) {
  switch (error.reason) {
    case "absent":
      // Since #86 this is reached by a parser that ran fine and found nothing
      // — most often a PDF that is a scan of a printed page, which has no text
      // layer to extract — as well as by an empty `.md`. The sentence names the
      // likely cause, because "no text" about a file the user can plainly read
      // on screen otherwise reads as a bug.
      return `No text could be read out of ${displayName}. If it is a scan or a photo of a printed CV there is no text in it to extract — a letter drafted from nothing would invent every specific in it and put them in your name.`

    case "too-short":
      return `${displayName} has too little in it to write a letter from. A letter drafted from that would invent its specifics and put them in your name.`

    case "too-long":
      return `${displayName} is too long to write a letter from. It is refused rather than trimmed — a letter written from half a CV reads exactly like one written from all of it.`

    default: {
      const _exhaustive: never = error.reason
      return _exhaustive
    }
  }
}
