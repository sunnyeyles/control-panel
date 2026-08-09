import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { POSTING_NOT_FOUND } from "@/lib/actions/not-found"
import { storageMessage } from "@/lib/actions/storage-message"
import { invokeTracedAgent } from "@/lib/agents/invoke-traced-agent"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { NoBackgroundReason } from "@/lib/candidate/candidate-background"
import { editPostingDocument } from "@/lib/posting-documents/edit-posting-document"
import { preparePostingDocument } from "@/lib/posting-documents/prepare-posting-document"
import type { Agent } from "@workspace/agents"
import type { UndraftableError } from "@workspace/agents/cover-letter"
import { createResumeTailor } from "@workspace/agents/resume-tailor"
import {
  TailoredResumeRequestSchema,
  toTailoredResumePrompt,
  type TailoredResumeRequest,
} from "@workspace/agents/tailored-resume"
import type { PrismaClient } from "@workspace/db"
import type { ResumeStore, TailoredResumeStore } from "@workspace/user-storage"

/**
 * Rewriting one resume for one Posting, as plain functions over injected
 * dependencies.
 *
 * **Nothing in this file imports Next**, which is the whole reason the security
 * branches can be tested: every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/jobs/actions.ts`, which is `"use server"`, supplies the real
 * dependencies, and calls `refresh()`.
 *
 * It is deliberately `cover-letter-actions.ts` with a different agent, and the
 * three properties transfer unchanged:
 *
 * 1. **The form carries one identifier, never a Posting.** A Posting body
 *    accepted from form data would let a caller put text of their choosing into
 *    a document stored in the user's own name. The Posting is re-read
 *    server-side out of `postings.payload` by
 *    `lib/postings/load-stored-posting.ts` — shared with the letters for exactly
 *    this reason — and `tailored-resume-actions.test.ts` submits a `posting`
 *    field and asserts it changes nothing.
 * 2. **The Posting is addressed by (session user, posting id).** `(user_id,
 *    posting_id)` is the natural key of `postings` and the user half comes from
 *    the session, so a stranger's advertisement cannot be *named* from here.
 * 3. **The storage key is built from the session's user id.** Nothing from the
 *    form reaches the `userId` segment, so `assertSegment` in
 *    `@workspace/user-storage` is a second line of defence rather than the only
 *    one.
 *
 * And the spending rule: the refusal for "no readable CV" happens **before** the
 * tailor is constructed, so a user with nothing to rewrite costs no model call.
 *
 * ⚠️ **Where this genuinely differs from the letters is what a bad output
 * costs.** A cover letter is prose a reader weighs; a resume is read as a list
 * of facts, and an invented employer in one is a false claim the user has to
 * answer for. Everything that keeps that from happening lives in the agent's
 * prompt (`packages/agents/src/resume-tailor.ts`) rather than here, because
 * there is nothing on this side to check it against — the output is markdown and
 * the source is markdown, and no schema distinguishes a reordered CV from an
 * embellished one. What this file can do, and does, is refuse to call the model
 * at all when the source document would not support an honest answer.
 *
 * ⚠️ **There is no counterpart to `createCoverLetter` here.** A letter can be
 * written from a blank editor because writing your own letter is ordinary; a
 * hand-written "tailored resume" with no generation behind it is a document the
 * user already has a place to put, under `/documents`. Adding one would mean a
 * second action that accepts resume text and can mint an object, which is the
 * pair {@link RESUME_NOT_FOUND} exists to keep apart.
 */

/**
 * One message for "no such Posting" and "someone else's Posting".
 *
 * Re-exported from `lib/actions/not-found.ts`, and the same string the letters
 * use. The identity is load-bearing: Posting ids are derived from an
 * advertisement's URL, so two messages would turn a form into an oracle for
 * whether a stranger has been shown it.
 */
export { POSTING_NOT_FOUND }

/** The object kind. Reaches a log line and the storage prefix, never a user. */
const KIND = "tailored-resumes"

/**
 * ⚠️ **Neither action in this file parses its own form, and the two parses are
 * still separate.** Generating asks for one identifier and saving asks for an
 * identifier and a body, and each of those schemas lives with the shared
 * function that enforces it — `preparePostingDocument` and `editPostingDocument`
 * respectively. That pair is the one most worth leaving free to diverge, since
 * one of them takes resume text from the caller and the other must never; two
 * modules is what keeps it so. What both spell the same way is the Posting id,
 * and there is one copy of that rule — see
 * `lib/posting-documents/posting-document-ref.ts`.
 */

/**
 * There is no tailored resume at that address to edit.
 *
 * ⚠️ **This refusal is the security property of {@link
 * createTailoredResumeActions.saveTailoredResume}, not a convenience.**
 * Generating deliberately never accepts resume text from a form — see property 1
 * above — because text taken from a form would become arbitrary content inside a
 * document stored in the user's own name. Saving *does* accept text, which is
 * safe only for as long as it can do nothing but overwrite something the caller
 * already has. Requiring the object to exist is what holds that line: without
 * it, a caller could spell any well-formed Posting id and mint a document of
 * their choosing at it.
 *
 * It is also the "not yours" answer, the same conflation the download route
 * makes: the key is built from the session's user, so another user's tailored
 * resume is not merely refused here — it cannot be addressed at all, and what
 * the caller sees is an empty prefix.
 */
export const RESUME_NOT_FOUND =
  "There is no tailored resume for that posting. Generate one before editing it."

/**
 * The longest tailored resume that can be saved.
 *
 * The generating path needs no such bound because a model wrote the bytes and
 * its own output limit is the ceiling. Here a person does, through a rich-text
 * editor that will paste whatever is on a clipboard. Generous by the standards
 * of a CV — a long one is a few thousand characters — because refusing a
 * legitimate document is worse than storing an overlong one, and the object
 * store is not the thing under pressure. The same number as a cover letter's
 * limit, and deliberately its own constant: the two are alike today by
 * coincidence of scale rather than because one implies the other.
 */
export const MAX_RESUME_CHARS = 50_000

/** Nothing survived the trim. */
const EMPTY_RESUME = "There is nothing to save — the resume is empty."

const RESUME_TOO_LONG = `That resume is too long to save. The limit is ${MAX_RESUME_CHARS.toLocaleString("en-AU")} characters.`

export interface TailoredResumeActionsDeps {
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
  /** Where the rewritten resume is written. */
  getTailoredResumes: () => TailoredResumeStore
  /**
   * The tailor. Defaults to the real agent, which reads `OPENAI_API_KEY` when
   * constructed — hence a factory called inside the action, never at module
   * scope. A test passes one built over a fake chat model.
   *
   * ⚠️ **It takes no arguments, unlike the letters' `createWriter`.** That one
   * receives the candidate's saved Letter Instructions because the system prompt
   * is composed from them. There is no such setting for resumes, so this agent's
   * prompt is fixed — and keeping the seam argument-less is what says so at the
   * type level rather than in a comment somebody has to find.
   */
  createTailor?: () => Agent
  /** Overridden in tests, so an assertion can name the generating instant. */
  now?: () => Date
  /** Overridden in tests, so an assertion can name the reset key. */
  newResetKey?: () => string
}

export function createTailoredResumeActions(deps: TailoredResumeActionsDeps) {
  const createTailor = deps.createTailor ?? (() => createResumeTailor())
  const now = deps.now ?? (() => new Date())
  const newResetKey = deps.newResetKey ?? (() => crypto.randomUUID())

  async function generateTailoredResume(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    // Who is asking, which Posting, whether there is a CV, and whether it is
    // enough of one — all of it before the tailor is constructed, so a user with
    // nothing to rewrite spends nothing. The order is `preparePostingDocument`'s
    // and is a property rather than plumbing; only the two sentences below are
    // this feature's to write.
    const prepared = await preparePostingDocument(deps, formData, KIND)

    if (!prepared.ok) {
      switch (prepared.reason) {
        case "refused":
          return fail(prepared.message)
        case "no-background":
          return fail(describeMissingBackground(prepared.missing))
        case "undraftable":
          return fail(describeUndraftable(prepared.error, prepared.displayName))
        default: {
          const _exhaustive: never = prepared
          return _exhaustive
        }
      }
    }

    const { userId, postingId, posting, lastSeenRunId, displayName } = prepared

    let request: TailoredResumeRequest
    try {
      request = TailoredResumeRequestSchema.parse({
        posting,
        profile: { background: prepared.background },
      })
    } catch (error) {
      console.error("tailored-resumes: the request would not validate", error)
      return fail("That posting could not be turned into a resume.")
    }

    let markdown: string
    try {
      markdown = await tailor(request, userId)
    } catch (error) {
      console.error("tailored-resumes: the tailor failed", error)
      return fail("The resume could not be generated. Try again in a moment.")
    }

    try {
      await deps.getTailoredResumes().put({
        // ⚠️ **The session's userId, never anything from the form.** There is
        // no way to *name* another user's prefix from here, which is what makes
        // the key-segment assertion in the store a second line of defence.
        userId,
        postingId,
        markdown,
        generatedAt: now(),
        // Provenance rides here rather than in the key — the key holds the
        // Posting id and nothing else, so re-generating overwrites one object.
        // Each value is model- or user-copied text and is stripped to what an
        // HTTP header can carry by the store; see `toMetadataRecord`.
        provenance: {
          // Absent for a Posting added by link — see the same spread in
          // `cover-letter-actions.ts`.
          ...(lastSeenRunId ? { runId: lastSeenRunId } : {}),
          title: posting.title,
          company: posting.company,
          url: posting.url,
          // Which Document this was rewritten from. `loadCandidateBackground`
          // picks the newest one labelled Resume, so the answer changes the
          // moment another is uploaded — recording it is the only way to know
          // afterwards which CV a given output came out of.
          sourceDocument: displayName,
        },
      })
    } catch (error) {
      return fail(storageMessage(`${KIND}: write failed`, error))
    }

    return {
      status: "success",
      message: `Tailored your resume for ${posting.title} at ${posting.company}, from ${displayName}. Read it against your own CV before you send it.`,
      // A fresh value per success rather than the posting id: re-generating the
      // same Posting is a second success and must read as one.
      resetKey: newResetKey(),
    }
  }

  /**
   * Save an edited tailored resume over the stored one.
   *
   * The counterpart to {@link generateTailoredResume}, and deliberately a
   * different shape: **no model, and no CV read.** The editor already contains
   * the user's own words.
   *
   * The order the checks run in — who is asking, then the shape of the id, then
   * the text, then whether there is anything at that address to overwrite — is
   * `editPostingDocument`'s and is a property rather than plumbing; only the
   * three sentences below are this feature's to write. In particular the second
   * of them, {@link RESUME_NOT_FOUND}, is the property that keeps an action
   * accepting resume text from being a way to create one, and `generatedAt` and
   * provenance are carried across rather than restamped because an edit is not a
   * generation — the detail panel renders "Generated <date>" and names the
   * source Document.
   */
  async function saveTailoredResume(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    const edited = await editPostingDocument(
      deps,
      formData,
      deps.getTailoredResumes(),
      { kind: KIND, maxChars: MAX_RESUME_CHARS }
    )

    if (!edited.ok) {
      switch (edited.reason) {
        case "refused":
          return fail(edited.message)
        case "empty":
          return fail(EMPTY_RESUME)
        case "too-long":
          return fail(RESUME_TOO_LONG)
        case "not-found":
          return fail(RESUME_NOT_FOUND)
        default: {
          const _exhaustive: never = edited
          return _exhaustive
        }
      }
    }

    return {
      status: "success",
      message: "Saved your changes to this tailored resume.",
      resetKey: newResetKey(),
    }
  }

  /**
   * One model call, traced.
   *
   * Tracing, the empty-answer throw and the choice of `.invoke()` over
   * `.stream()` all belong to {@link invokeTracedAgent}, which says why — and in
   * particular why losing this run's transcript would be worse than losing most.
   * What is this feature's own is the prompt.
   */
  async function tailor(
    request: TailoredResumeRequest,
    userId: string
  ): Promise<string> {
    return invokeTracedAgent(createTailor(), {
      name: "tailored-resume",
      route: "/jobs",
      userId,
      prompt: toTailoredResumePrompt(request),
    })
  }

  return { generateTailoredResume, saveTailoredResume }
}

/**
 * Why there is nothing to rewrite, as something to act on.
 *
 * The same three reasons the letters have, said for this feature — the wording
 * differs because the instruction differs. `resumes` accepts more on upload than
 * anything can read, so a user is being refused a document the app already took,
 * and without the sentence naming formats the refusal reads as a bug.
 */
function describeMissingBackground(reason: NoBackgroundReason) {
  switch (reason) {
    case "no-resume":
      return "No resume to tailor. Upload your CV under Documents and label it Resume — a PDF, a Word .docx, or a .md or .txt file."

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
 * The three ways a document can be present and still not be worth rewriting.
 *
 * ⚠️ **These bounds are measured on the *extracted* text, not on the file.** A
 * 200 KB PDF whose text layer is a name and a phone number is `too-short`, and
 * an eight-page CV is `too-long` however small the DOCX compresses to. That is
 * why `loadCandidateBackground` extracts before `assertDraftable` runs rather
 * than the other way round.
 */
function describeUndraftable(error: UndraftableError, displayName: string) {
  switch (error.reason) {
    case "absent":
      // Reached by a parser that ran fine and found nothing — most often a PDF
      // that is a scan of a printed page, which has no text layer to extract —
      // as well as by an empty `.md`. The sentence names the likely cause,
      // because "no text" about a file the user can plainly read on screen
      // otherwise reads as a bug.
      return `No text could be read out of ${displayName}. If it is a scan or a photo of a printed CV there is no text in it to extract — and a resume written from nothing would invent every line in it and put them in your name.`

    case "too-short":
      return `${displayName} has too little in it to tailor. There is nothing to reorder or emphasise, and anything produced from it would be invented rather than rewritten.`

    case "too-long":
      return `${displayName} is too long to tailor. It is refused rather than trimmed — a resume rewritten from half a CV silently drops whichever half came second, and reads exactly like one rewritten from all of it.`

    default: {
      const _exhaustive: never = error.reason
      return _exhaustive
    }
  }
}
