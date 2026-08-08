import { requireUser } from "@/lib/actions/require-user"
import { storageMessage } from "@/lib/actions/storage-message"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  loadCandidateBackground,
  type NoBackgroundReason,
} from "@/lib/cover-letters/candidate-background"
import type { Agent } from "@workspace/agents"
import type { PrismaClient } from "@workspace/db"
import {
  assertDraftable,
  UndraftableError,
} from "@workspace/agents/cover-letter"
import { parseSearchCriteria } from "@workspace/agents/criteria"
import {
  createProfileExtractor,
  toProfilePrompt,
} from "@workspace/agents/profile-extractor"
import { createLangfuseCallback } from "@workspace/langfuse"
import { type ResumeStore } from "@workspace/user-storage"

import type { CriteriaSuggestionState } from "./criteria-suggestion"

/**
 * Proposing what to search for, read out of the CV the user already uploaded.
 *
 * **Nothing in this file imports Next**, like `lib/cover-letters/
 * cover-letter-actions.ts` beside it, and for the same reason: every
 * authorization branch here turns on who is asking, and a session is exactly
 * what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/jobs/schedules/actions.ts`, which is `"use server"` and supplies
 * the real dependencies.
 *
 * Three properties this module exists to hold, none of which is visible from
 * the happy path:
 *
 * 1. **It persists nothing, and therefore calls no `refresh()`.** The criteria
 *    come back as a value the form renders into its own fields, and the user
 *    then edits them and submits the *create* action — which is where anything
 *    is written. That is what makes "the user reviews the suggestion before it
 *    is saved" a structural fact rather than a promise the UI makes: there is no
 *    write on this path to review *after*. It also means there is no cached
 *    segment to invalidate, which is why the wrapper is the one action in that
 *    file with no `refresh()` and says so.
 * 2. **No form field is read at all.** The CV is found from the session's user
 *    id, through the same `loadCandidateBackground` the cover-letter action
 *    uses, so there is no field a caller could tamper with to make this read
 *    somebody else's document — and nothing from the request reaches the model's
 *    prompt. Both parameters exist only because `useActionState` dictates the
 *    signature.
 * 3. **A user with no readable CV costs no model call.** Every refusal below —
 *    not signed in, nothing labelled Resume, a format with no parser, a document
 *    too thin to read anything out of — happens *before* the extractor is
 *    constructed. The suite asserts the injected factory was never called, which
 *    is the only way that property can be seen.
 *
 * The model is deliberately the one agent in the repository with no tools; see
 * `createProfileExtractor` for why that is containment rather than tuning. It is
 * handed the whole CV verbatim, including whatever address and employment
 * history it carries, and having nowhere to send it is what makes that
 * acceptable.
 */

/**
 * The extractor ran and what came back could not be used.
 *
 * Deliberately one message for three distinct causes — the call failed, the
 * final message was empty, or the JSON did not parse against
 * `SearchCriteriaSchema`. None of the three is anything the person holding the
 * CV can act on differently, and all three have the same remedy: press the
 * button again. The distinction is in the server log, where the person who can
 * do something about it will look.
 *
 * Exported so the tests assert on the constant rather than on a copy of the
 * sentence, which is how copy and assertion drift apart.
 */
export const EXTRACTION_FAILED =
  "Your resume could not be turned into search criteria. Try again in a moment."

export interface SuggestCriteriaActionsDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /**
   * Where the candidate's own document is read from. Resolved per call rather
   * than held, so the factory constructs no `S3Client` at module scope and
   * cannot read configuration at import time.
   */
  getResumes: () => ResumeStore
  /**
   * Which document the user called their resume. Resolved per call for the
   * same reason the store is — the bucket has the bytes, and only Postgres
   * knows which of them to read.
   */
  getPrisma: () => PrismaClient
  /**
   * The extractor. Defaults to the real agent, which reads `OPENAI_API_KEY`
   * when constructed — hence a factory **called inside the action**, never at
   * module scope. Two things follow from that placement, and both matter:
   * importing this module cannot throw on a missing key, and the refusals above
   * can be reached without ever building a model.
   *
   * A test passes one that records the prompt it was given and answers with a
   * canned reply.
   */
  createExtractor?: () => Agent
  /** Overridden in tests, so an assertion can name the reset key. */
  newResetKey?: () => string
}

/**
 * What the factory returns, stated rather than inferred — and the reason is the
 * one asymmetry in this module.
 *
 * ⚠️ **The action accepts `(state, formData)` and reads neither.** That
 * signature is `useActionState`'s, not this action's: there is no previous
 * state worth carrying (see the `fail` helper, which mints no reset key) and no
 * form field is consulted, which is property 2 in the docblock above — nothing
 * a caller puts in the request reaches the store lookup or the model's prompt.
 *
 * Declaring the type here and implementing with no parameters at all is what
 * expresses that in the code rather than only in a comment. The alternative —
 * naming them `_state` and `_formData` — reads as "unused for now" and, in this
 * repo's ESLint config, warns anyway: there is no `argsIgnorePattern`, so the
 * underscore buys nothing.
 */
export interface SuggestCriteriaActions {
  suggestCriteria: (
    state: CriteriaSuggestionState,
    formData: FormData
  ) => Promise<CriteriaSuggestionState>
}

export function createSuggestCriteriaActions(
  deps: SuggestCriteriaActionsDeps
): SuggestCriteriaActions {
  const createExtractor =
    deps.createExtractor ?? (() => createProfileExtractor())
  const newResetKey = deps.newResetKey ?? (() => crypto.randomUUID())

  async function suggestCriteria(): Promise<CriteriaSuggestionState> {
    /**
     * Every failure is just a message.
     *
     * ⚠️ **No reset key is carried on this path, unlike `ActionState`.** The
     * form keys its criteria fields on the *success* key alone, so there is
     * nothing for a failure to preserve — and that is the point rather than an
     * omission: a suggestion that fails must leave whatever the user had
     * already typed into those fields exactly where it was. A key that appeared
     * or changed here would remount the fields and throw that text away, at the
     * precise moment the user is being told to try again.
     */
    const fail = (message: string): CriteriaSuggestionState => ({
      status: "error",
      message,
    })

    // Before the body is touched at all. For a Server Action this is not a
    // second layer: `proxy.ts` cannot evaluate a POST session — the auth SDK's
    // fast path is guarded by `method === "GET"` — so it degrades to checking
    // that some session-cookie substring is present. This is the only real
    // check on the path.
    //
    // `"briefings"` rather than a domain of its own: the log prefix names the
    // feature the criteria belong to, and this action exists to fill in a
    // briefing's search.
    const caller = await requireUser(deps.getUser, "briefings")
    if (!caller.ok) return fail(caller.message)

    // Before the extractor is constructed, so a user with nothing to read costs
    // nothing. This is also where a PDF or a DOCX is parsed — still on this side
    // of the model call, which is what keeps the bounds below applying to the
    // text that was actually extracted rather than to the file it came out of.
    let background
    try {
      background = await loadCandidateBackground(
        caller.userId,
        deps.getPrisma(),
        deps.getResumes()
      )
    } catch (error) {
      return fail(storageMessage("briefings: read failed", error))
    }

    if (!background.ok)
      return fail(describeMissingBackground(background.reason))

    try {
      // ⚠️ **`assertDraftable`, reused rather than restated.** The bounds it
      // enforces are `MIN_BACKGROUND_CHARS` and `MAX_BACKGROUND_CHARS` from
      // `@workspace/agents/cover-letter`, and borrowing a letter-flavoured
      // function for a search-flavoured feature is the lesser of two evils on
      // purpose: a second copy of the numbers is a bound that has to move in
      // lockstep with the first and will not, and the only cost of sharing is
      // that a sentence mentioning letters reaches a *server log*. Nothing the
      // user sees comes from the thrown message — `describeUnextractable`
      // rewrites all three cases below.
      //
      // The bounds themselves apply here for the same reason they apply to a
      // letter, and arguably harder. Criteria read out of almost nothing are
      // not vague criteria, they are invented ones, and unlike a letter nobody
      // reads them once: they are saved and searched on a cadence, so a guess
      // made here comes back every day as briefs full of the wrong roles.
      assertDraftable({ background: background.background })
    } catch (error) {
      if (error instanceof UndraftableError) {
        return fail(describeUnextractable(error, background.displayName))
      }

      console.error("briefings: the CV could not be checked", error)
      return fail(EXTRACTION_FAILED)
    }

    let criteria
    try {
      // Only now is a model constructed — see property 3. Everything above this
      // line refuses for free.
      criteria = await extract(background.background, caller.userId)
    } catch (error) {
      // Covers the invocation failing, an empty final message, and output that
      // does not parse against the schema. `parseSearchCriteria` throws rather
      // than degrading, deliberately, and this is the catch that turns that
      // throw into something a person can act on.
      console.error("briefings: the profile extractor failed", error)
      return fail(EXTRACTION_FAILED)
    }

    // ⚠️ Anything the extractor wanted to say about the extraction, kept only
    // when it said something. An empty string rendered beside the fields would
    // be a caption with nothing in it; the *absence* of the field is what the
    // form branches on.
    const notes = criteria.notes?.trim() ?? ""

    return {
      status: "success",
      // Joined with `", "` because that is the format the fields take and the
      // format `searchCriteriaSchema` parses on the way back in — the user
      // edits this by hand before submitting it, so it has to arrive as the
      // thing a person edits rather than as an array they cannot see.
      //
      // An empty array joins to `""`, which is a real answer rather than a
      // missing one: a CV that states no location genuinely says nothing about
      // where to search, and `notes` is where the extractor explains that.
      criteria: {
        titles: criteria.titles.join(", "),
        locations: criteria.locations.join(", "),
        keywords: criteria.keywords.join(", "),
      },
      ...(notes.length > 0 ? { notes } : {}),
      // A fresh value per success. Two suggestions in a row are two successes
      // and must both remount the fields, even if the criteria happen to be
      // identical.
      resetKey: newResetKey(),
    }
  }

  /**
   * One model call, traced, and its answer validated.
   *
   * ⚠️ **The callback is not optional decoration.** Every other agent run in
   * this repository reports to Langfuse — `generate-briefing` from the worker,
   * `chat-response` and `cover-letter` from the dashboard — and one that did not
   * would be the only agent invocation whose prompt and output nobody can
   * inspect after the fact. That is a bad trade anywhere, and a worse one here:
   * the prompt is the user's entire CV, and when the criteria come back subtly
   * wrong the transcript is the only place the reason exists. The shape is
   * `cover-letter-actions.ts`'s: a handler per invocation (they retain run
   * state, so sharing one would mix traces), `langfuseUserId`/
   * `langfuseSessionId` in metadata, and the callback spread in only when
   * Langfuse is configured — it is `undefined` without keys, and
   * `callbacks: [undefined]` is not the same as no callbacks.
   *
   * `.invoke()` rather than `.stream()`: the extractor has **no tools**, so the
   * graph is START → model → END and there are no intermediate steps for a
   * stream to be interesting about. The answer is also a single JSON object,
   * which is the least useful thing there is to stream.
   *
   * The parse lives here rather than at the call site so that all three ways
   * this can go wrong — a failed call, an empty message, unusable JSON — leave
   * by the same `throw` and are answered by the same catch. Splitting them
   * would mean three catches producing one message.
   */
  async function extract(background: string, userId: string) {
    const extractor = createExtractor()
    const sessionId = crypto.randomUUID()

    const callback = createLangfuseCallback({
      userId,
      sessionId,
      tags: ["dashboard", "search-criteria"],
      traceMetadata: {
        feature: "search-criteria",
        route: "/jobs/schedules",
      },
    })

    const result = await extractor.invoke(
      { messages: [{ role: "user", content: toProfilePrompt(background) }] },
      {
        runName: "search-criteria",
        metadata: {
          langfuseUserId: userId,
          langfuseSessionId: sessionId,
        },
        ...(callback ? { callbacks: [callback] } : {}),
      }
    )

    const text = result.messages.at(-1)?.text.trim() ?? ""

    if (text.length === 0) {
      // Distinct from unparseable output only in the log. A model that answered
      // with nothing has told us nothing about the CV, so proposing empty
      // criteria would be proposing a search for everything.
      throw new Error("The profile extractor returned an empty message.")
    }

    return parseSearchCriteria(text)
  }

  return { suggestCriteria }
}

/**
 * Why there is nothing to read criteria out of, as something to act on.
 *
 * ⚠️ **A separate switch from `describeMissingBackground` in
 * `cover-letter-actions.ts`, over the same union, on purpose.** The two are not
 * a copy waiting to be deduplicated: every sentence differs where it names what
 * the document was *for*, and the shared version would have to say something
 * vague enough to cover both ("your resume could not be used"), which is exactly
 * the message neither user can do anything with. The union is what is shared,
 * and the exhaustiveness check below is what makes a new reason a compile error
 * in both places rather than a silent fall-through in one.
 *
 * Every message names the acceptable formats outright, for the reason the
 * cover-letter version documents: `resumes` accepts more on upload than anything
 * can read, so the user is being refused a document the app already took, and
 * without the sentence the refusal reads as a bug.
 */
function describeMissingBackground(reason: NoBackgroundReason) {
  switch (reason) {
    case "no-resume":
      return "No resume to work out a search from. Upload your CV under Documents and label it Resume — a PDF, a Word .docx, or a .md or .txt file — then try again."

    case "unreadable-format":
      // ⚠️ Not a leftover. `.doc`, `.odt` and `.rtf` are still accepted on
      // upload and still have no parser, so this refusal has to name those
      // three rather than the formats that do work.
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
 * The three ways a document can be present and still yield no search.
 *
 * The mirror of `describeUndraftable`, over the same `UndraftableError` the same
 * `assertDraftable` throws — the bounds are shared, and only the consequence
 * named in each sentence differs. Here the consequence is worth stating plainly
 * because it is not a one-off: criteria invented from a document that says
 * nothing get saved and then searched on a cadence, so the mistake repeats
 * daily and looks like a quiet hiring market rather than like a bad extraction.
 *
 * ⚠️ **The bounds are measured on the *extracted* text, not on the file.** A
 * 200 KB PDF whose text layer is a name and a phone number is `too-short`, and
 * an eight-page CV is `too-long` however small the DOCX compresses to. That is
 * why `loadCandidateBackground` extracts before `assertDraftable` runs rather
 * than the other way round.
 */
function describeUnextractable(error: UndraftableError, displayName: string) {
  switch (error.reason) {
    case "absent":
      // Reached by a parser that ran perfectly and found nothing — most often a
      // PDF that is a scan of a printed page, which has no text layer at all —
      // as well as by an empty `.md`. The sentence names the likely cause,
      // because "no text" about a file the user can plainly read on screen
      // otherwise reads as a bug.
      return `No text could be read out of ${displayName}. If it is a scan or a photo of a printed CV there is no text in it to extract, and a search built from nothing would be a search for roles you never claimed.`

    case "too-short":
      return `${displayName} has too little in it to work out what to search for. Criteria drawn from that would be guessed rather than read — and they would be saved and searched every day afterwards. Point this at your full CV and try again.`

    case "too-long":
      return `${displayName} is too long to read a search out of. It is refused rather than trimmed: criteria drawn from half a CV read exactly like criteria drawn from all of it, and the half that gets dropped is usually the earlier career that shows your seniority.`

    default: {
      const _exhaustive: never = error.reason
      return _exhaustive
    }
  }
}
