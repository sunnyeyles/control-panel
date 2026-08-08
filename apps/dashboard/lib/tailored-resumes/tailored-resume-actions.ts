import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { POSTING_NOT_FOUND } from "@/lib/actions/not-found"
import { requireUser } from "@/lib/actions/require-user"
import { storageMessage } from "@/lib/actions/storage-message"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  loadCandidateBackground,
  type NoBackgroundReason,
} from "@/lib/cover-letters/candidate-background"
import { POSTING_ID_PATTERN } from "@/lib/cover-letters/cover-letter-ref"
import {
  loadStoredPosting,
  storedPostingMessage,
} from "@/lib/postings/load-stored-posting"
import type { Agent } from "@workspace/agents"
import {
  assertDraftable,
  UndraftableError,
} from "@workspace/agents/cover-letter"
import { createResumeTailor } from "@workspace/agents/resume-tailor"
import {
  TailoredResumeRequestSchema,
  toTailoredResumePrompt,
  type TailoredResumeRequest,
} from "@workspace/agents/tailored-resume"
import type { PrismaClient } from "@workspace/db"
import { createLangfuseCallback } from "@workspace/langfuse"
import {
  isUserStorageError,
  type ResumeStore,
  type StoredTailoredResume,
  type TailoredResumeStore,
} from "@workspace/user-storage"
import { z } from "zod"

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

/** Reachable only by posting a form directly; the buttons always send it. */
const BAD_REQUEST = "That posting could not be identified."

/**
 * ⚠️ **This is {@link saveSchema} without its `markdown`, and that is the two
 * actions agreeing rather than a duplication to collapse.** A tailored resume is
 * addressed by `(user, Posting)` however it came to exist, so each action asks
 * for exactly one identifier. Sharing one schema would tie what a generation
 * accepts to what an edit accepts, which is the pair most worth leaving free to
 * diverge: one of them takes resume text from the caller, and the other must
 * never.
 */
const generateSchema = z.object({
  postingId: z.string().regex(POSTING_ID_PATTERN),
})

const saveSchema = z.object({
  postingId: z.string().regex(POSTING_ID_PATTERN),
  markdown: z.string(),
})

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

    // Before the body is touched at all. For a Server Action this is not a
    // second layer: `proxy.ts` cannot evaluate a POST session — the auth SDK's
    // fast path is guarded by `method === "GET"` — so it degrades to checking
    // that some session-cookie substring is present. This is the only real
    // check on the path.
    const caller = await requireUser(deps.getUser, "tailored-resumes")
    if (!caller.ok) return fail(caller.message)

    // ⚠️ **Only this one field is read, and that is the security property.**
    // `formData` may well carry a `posting` — the test suite submits one — and
    // nothing here looks at it.
    const parsed = generateSchema.safeParse({
      postingId: formData.get("postingId"),
    })

    if (!parsed.success) return fail(BAD_REQUEST)

    const stored = await loadStoredPosting(
      deps.getPrisma(),
      caller.userId,
      parsed.data.postingId,
      "tailored-resumes"
    )
    if (stored.status !== "found") return fail(storedPostingMessage(stored))

    const { posting, lastSeenRunId } = stored

    // Before the tailor is constructed, so a user with nothing to rewrite spends
    // nothing. This is also where a PDF or a DOCX is parsed — still on this side
    // of the model call, which is what keeps the bounds below applying to the
    // text that was actually extracted.
    let background
    try {
      background = await loadCandidateBackground(
        caller.userId,
        deps.getPrisma(),
        deps.getResumes()
      )
    } catch (error) {
      return fail(storageMessage(`tailored-resumes: read failed`, error))
    }

    if (!background.ok)
      return fail(describeMissingBackground(background.reason))

    let request: TailoredResumeRequest
    try {
      // Still before the model call, and measured on the *extracted* text.
      // `assertDraftable` is the letters' guard, reused rather than restated —
      // it takes a structural `{ background }` for exactly this, and the
      // question it answers is the same one: is there enough of this person's
      // own document to work from? A resume rewritten from too little is not a
      // thin resume, it is a fabricated one.
      assertDraftable({ background: background.background })

      request = TailoredResumeRequestSchema.parse({
        posting,
        profile: { background: background.background },
      })
    } catch (error) {
      if (error instanceof UndraftableError) {
        return fail(describeUndraftable(error, background.displayName))
      }

      console.error("tailored-resumes: the request would not validate", error)
      return fail("That posting could not be turned into a resume.")
    }

    let markdown: string
    try {
      markdown = await tailor(request, caller.userId)
    } catch (error) {
      console.error("tailored-resumes: the tailor failed", error)
      return fail("The resume could not be generated. Try again in a moment.")
    }

    try {
      await deps.getTailoredResumes().put({
        // ⚠️ **The session's userId, never anything from the form.** There is
        // no way to *name* another user's prefix from here, which is what makes
        // the key-segment assertion in the store a second line of defence.
        userId: caller.userId,
        postingId: parsed.data.postingId,
        markdown,
        generatedAt: now(),
        // Provenance rides here rather than in the key — the key holds the
        // Posting id and nothing else, so re-generating overwrites one object.
        // Each value is model- or user-copied text and is stripped to what an
        // HTTP header can carry by the store; see `toMetadataRecord`.
        provenance: {
          runId: lastSeenRunId,
          title: posting.title,
          company: posting.company,
          url: posting.url,
          // Which Document this was rewritten from. `loadCandidateBackground`
          // picks the newest one labelled Resume, so the answer changes the
          // moment another is uploaded — recording it is the only way to know
          // afterwards which CV a given output came out of.
          sourceDocument: background.displayName,
        },
      })
    } catch (error) {
      return fail(storageMessage(`tailored-resumes: write failed`, error))
    }

    return {
      status: "success",
      message: `Tailored your resume for ${posting.title} at ${posting.company}, from ${background.displayName}. Read it against your own CV before you send it.`,
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
   * Three things this holds, in order:
   *
   * 1. **Who is asking, before the body is touched.** Same reasoning as the
   *    generate action: for a Server Action `proxy.ts` cannot evaluate the
   *    session on a POST, so this is the only real check.
   * 2. **The resume must already exist** — see {@link RESUME_NOT_FOUND}, which
   *    is where the reasoning lives, because it is the property that keeps an
   *    action accepting resume text from being a way to create one.
   * 3. **`generatedAt` and provenance are carried across, never restamped.** An
   *    edit is not a generation. The detail panel renders "Generated <date>" and
   *    names the source Document — a save that restamped either would have the
   *    page report that the model rewrote the resume just now, or would attribute
   *    it to whichever CV happens to be newest today.
   */
  async function saveTailoredResume(
    state: ActionState,
    formData: FormData
  ): Promise<ActionState> {
    const fail = (message: string) => carryResetKey(state, message)

    const caller = await requireUser(deps.getUser, "tailored-resumes")
    if (!caller.ok) return fail(caller.message)

    const parsed = saveSchema.safeParse({
      postingId: formData.get("postingId"),
      markdown: formData.get("markdown"),
    })

    if (!parsed.success) return fail(BAD_REQUEST)

    // Normalized before it is measured and before it is stored, for the reasons
    // `cover-letter-actions.ts` sets out at length: ProseMirror already
    // normalizes `\r\n` on the way in, so this line is unreachable through the
    // UI and stays because a Server Action is reachable by direct POST with a
    // FormData nobody typed — and the store is told `text/markdown`. `trim()`
    // because a document that is only whitespace is an empty one however much of
    // it there is, and Turndown leaves a trailing newline on nearly everything.
    const markdown = parsed.data.markdown.replace(/\r\n/g, "\n").trim()

    if (markdown.length === 0) return fail(EMPTY_RESUME)
    if (markdown.length > MAX_RESUME_CHARS) return fail(RESUME_TOO_LONG)

    const resumes = deps.getTailoredResumes()

    // ⚠️ **The session's userId, never anything from the form** — the same rule
    // as the generate action, and the reason a request naming another user's
    // document cannot be spelled rather than merely being refused.
    const ref = { userId: caller.userId, postingId: parsed.data.postingId }

    let existing: StoredTailoredResume
    try {
      existing = await resumes.head(ref)
    } catch (error) {
      if (
        isUserStorageError(error) &&
        (error.code === "object_not_found" ||
          error.code === "object_ownership" ||
          error.code === "invalid_object_key")
      ) {
        return fail(RESUME_NOT_FOUND)
      }

      // Anything else is the bucket being unreachable, which must not be
      // reported as "you have not generated this" — that would tell a user
      // their document is gone during an outage.
      return fail(storageMessage(`tailored-resumes: read failed`, error))
    }

    try {
      await resumes.put({
        ...ref,
        markdown,
        generatedAt: existing.generatedAt,
        provenance: existing.provenance,
      })
    } catch (error) {
      return fail(storageMessage(`tailored-resumes: write failed`, error))
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
   * ⚠️ **The callback is not optional decoration.** Every other agent run in
   * this repository reports to Langfuse — `generate-briefing` from the worker,
   * `chat-response` and `cover-letter` from the dashboard — and one that did not
   * would be the only agent invocation whose prompt and output nobody can inspect
   * after the fact. For a document that makes factual claims in the user's name
   * that is the worst place to lose the transcript: "did the model invent this
   * employer, or was it in the CV" is answerable from a trace and from nothing
   * else. The shape is `lib/chat-handler.ts`'s: a handler per invocation (they
   * retain run state, so sharing one would mix traces), `langfuseUserId` and
   * `langfuseSessionId` in metadata, and the callback spread in only when
   * Langfuse is configured — it is `undefined` without keys, and
   * `callbacks: [undefined]` is not the same as no callbacks.
   *
   * `.invoke()` rather than `.stream()`: the tailor has no tools, so the graph is
   * START → model → END and there are no intermediate steps for a stream to be
   * interesting about.
   */
  async function tailor(
    request: TailoredResumeRequest,
    userId: string
  ): Promise<string> {
    const agent = createTailor()
    const sessionId = crypto.randomUUID()

    const callback = createLangfuseCallback({
      userId,
      sessionId,
      tags: ["dashboard", "tailored-resume"],
      traceMetadata: {
        feature: "tailored-resume",
        route: "/jobs",
      },
    })

    const result = await agent.invoke(
      {
        messages: [{ role: "user", content: toTailoredResumePrompt(request) }],
      },
      {
        runName: "tailored-resume",
        metadata: {
          langfuseUserId: userId,
          langfuseSessionId: sessionId,
        },
        ...(callback ? { callbacks: [callback] } : {}),
      }
    )

    const resume = result.messages.at(-1)?.text.trim() ?? ""

    if (resume.length === 0) {
      throw new Error("The tailor returned an empty resume.")
    }

    return resume
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
