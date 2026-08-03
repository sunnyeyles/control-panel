import { carryResetKey, type ActionState } from "@/lib/actions/action-state"
import { requireUser } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import { loadCandidateBackground } from "@/lib/cover-letters/candidate-background"
import { POSTING_ID_PATTERN } from "@/lib/cover-letters/cover-letter-ref"
import type { Agent } from "@workspace/agents"
import {
  assertDraftable,
  CoverLetterRequestSchema,
  toCoverLetterPrompt,
  UndraftableError,
  type CoverLetterRequest,
} from "@workspace/agents/cover-letter"
import { createCoverLetterWriter } from "@workspace/agents/cover-letter-writer"
import { FindingsSchema, type Posting } from "@workspace/agents/findings"
import { postingId } from "@workspace/agents/posting-id"
import type { PrismaClient } from "@workspace/db"
import { createLangfuseCallback } from "@workspace/langfuse"
import {
  isUserStorageError,
  type CoverLetterStore,
  type ResumeStore,
} from "@workspace/user-storage"
import { z } from "zod"

/**
 * Drafting one cover letter for one Posting, as plain functions over injected
 * dependencies.
 *
 * **Nothing in this file imports Next**, which is the whole reason the security
 * branches can be tested: every one of them turns on who is asking, and a
 * session is exactly what a unit test cannot produce. The Next-aware wrapper is
 * `app/(app)/briefings/actions.ts`, which is `"use server"`, supplies the real
 * dependencies, and calls `refresh()`.
 *
 * Three properties this module exists to hold, each of which would be invisible
 * if it were satisfied only by the current call site:
 *
 * 1. **The form carries identifiers, never a Posting.** A Posting arriving in
 *    form data would let a caller put text of their choosing into a stored
 *    document written in the user's voice — and it would break *copied, never
 *    composed* at the last step of the chain that maintains it. The Posting is
 *    re-read out of the Run's stored Findings and matched by
 *    {@link postingId}. `cover-letter-actions.test.ts` submits a `posting`
 *    field and asserts it changes nothing.
 * 2. **Run ownership is checked, not assumed.** The run id arrives from a
 *    hidden field, so the Run and its Job are loaded and the Job's owner must
 *    be the caller.
 * 3. **The storage key is built from the session's user id.** Nothing from the
 *    form reaches the `userId` segment, so `assertSegment` in
 *    `@workspace/user-storage` is a second line of defence rather than the only
 *    one.
 *
 * And one that is about spending rather than security: the refusal for "no
 * readable CV" happens **before** the writer is constructed, so a user with
 * nothing to write from costs no model call. That is the same rule as
 * `assertDraftable`, one step earlier.
 */

/**
 * One message for "no such run" and "someone else's run".
 *
 * Distinct messages would turn a hidden field that takes a uuid into an oracle
 * for whether another user's Run exists — the same reasoning `lib/jobs/
 * job-actions.ts` gives for its `NOT_FOUND`.
 */
export const RUN_NOT_FOUND = "That briefing run could not be found."

/** Reachable only by posting the form directly; the button always sends both. */
const BAD_REQUEST = "That posting could not be identified."

/**
 * The Posting was not in that Run's Findings.
 *
 * Ordinary rather than exotic: a Run's Findings are replaced by the next Run,
 * and a page open in another tab still holds the previous set.
 */
const POSTING_GONE =
  "That posting is no longer in this briefing's latest run. Refresh the page and try again."

/**
 * The Posting id shape, from `cover-letter-ref.ts`.
 *
 * It lived here until the download route needed the same rule; the reasoning
 * for why it is restated at all rather than exported from `@workspace/agents`
 * moved with it. One copy, because it is what makes every value reaching the
 * store a legal key segment by construction.
 */
const draftSchema = z.object({
  runId: z.uuid(),
  postingId: z.string().regex(POSTING_ID_PATTERN),
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
   */
  createWriter?: () => Agent
  /** Overridden in tests, so an assertion can name the drafting instant. */
  now?: () => Date
  /** Overridden in tests, so an assertion can name the reset key. */
  newResetKey?: () => string
}

export function createCoverLetterActions(deps: CoverLetterActionsDeps) {
  const createWriter = deps.createWriter ?? (() => createCoverLetterWriter())
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

    // ⚠️ **Only these two fields are read, and that is the security property.**
    // `formData` may well carry a `posting` — the test suite submits one — and
    // nothing here looks at it. A Posting body accepted from a form would be
    // arbitrary text stored in a document written in the user's voice.
    const parsed = draftSchema.safeParse({
      runId: formData.get("runId"),
      postingId: formData.get("postingId"),
    })

    if (!parsed.success) return fail(BAD_REQUEST)

    let run
    try {
      run = await deps.getPrisma().run.findUnique({
        where: { id: parsed.data.runId },
        select: { id: true, findings: true, job: { select: { userId: true } } },
      })
    } catch (error) {
      console.error("cover-letters: could not load the run", error)
      return fail("Something went wrong.")
    }

    // **Ownership, explicitly.** The run id came from a hidden field, so the
    // Job it hangs off is loaded and its owner compared to the caller. There is
    // no `where: { job: { userId } }` shortcut here on purpose: the comparison
    // is the thing being asserted, and a test that seeds another user's Run
    // needs it to be visible rather than folded into a query.
    if (!run || run.job.userId !== caller.userId) return fail(RUN_NOT_FOUND)

    const findings = FindingsSchema.safeParse(run.findings)

    if (!findings.success) {
      // Covers both "the Run kept none" and "what it kept does not parse".
      // Neither is actionable by the user beyond re-running the briefing.
      console.error("cover-letters: findings are unreadable", run.id)
      return fail(POSTING_GONE)
    }

    // The Posting, re-read server-side and matched by identifier. This is the
    // line the first property above is about.
    const posting: Posting | undefined = findings.data.postings.find(
      (candidate) => postingId(candidate) === parsed.data.postingId
    )

    if (!posting) return fail(POSTING_GONE)

    // Before the writer is constructed, so a user with nothing to write from
    // spends nothing.
    let background
    try {
      background = await loadCandidateBackground(
        caller.userId,
        deps.getResumes()
      )
    } catch (error) {
      return fail(storageMessage("read", error))
    }

    if (!background.ok)
      return fail(describeMissingBackground(background.reason))

    let request: CoverLetterRequest
    try {
      // Still before the model call: a letter written from too little is not a
      // thin letter, it is a fabricated one, and every specific in it would be
      // invented and then attributed to the user.
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

    let markdown: string
    try {
      markdown = await draft(request, caller.userId)
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
          runId: run.id,
          title: posting.title,
          company: posting.company,
          url: posting.url,
        },
      })
    } catch (error) {
      return fail(storageMessage("write", error))
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
    userId: string
  ): Promise<string> {
    const writer = createWriter()
    const sessionId = crypto.randomUUID()

    const callback = createLangfuseCallback({
      userId,
      sessionId,
      tags: ["dashboard", "cover-letter"],
      traceMetadata: {
        feature: "cover-letter",
        route: "/briefings",
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

  return { draftCoverLetter }
}

/**
 * Why there is nothing to write from, as something to act on.
 *
 * Both messages name the formats outright. That is a requirement rather than
 * helpfulness: a user whose CV is a PDF has uploaded the right document and is
 * being refused anyway, and without the sentence the refusal reads as a bug.
 */
function describeMissingBackground(reason: "no-resume" | "unreadable-format") {
  switch (reason) {
    case "no-resume":
      return "No resume to write from. Upload your CV under Documents and label it Resume — it has to be a .md or .txt file, because PDF and DOCX cannot be read yet."

    case "unreadable-format":
      return "Your resume is a PDF or a Word file, and reading those is not built yet. Upload the same CV as a .md or .txt file, labelled Resume, and try again."

    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
}

/** The three ways a document can be present and still not be writable from. */
function describeUndraftable(error: UndraftableError, displayName: string) {
  switch (error.reason) {
    case "absent":
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

/**
 * A storage failure as something safe to show.
 *
 * Branches on `code`, never `instanceof`, for the reason `errors.ts` states: an
 * error crossing a bundler or package boundary can fail a prototype check while
 * carrying a perfectly good discriminant. Detail goes to the server log alone.
 */
function storageMessage(operation: "read" | "write", error: unknown): string {
  console.error(`cover-letters: ${operation} failed`, error)

  if (!isUserStorageError(error)) return "Something went wrong."

  switch (error.code) {
    case "object_not_found":
    case "object_ownership":
      // Conflated, as everywhere else here: splitting them would say whether an
      // object exists to someone who may not read it.
      return "That document no longer exists."

    case "storage_unavailable":
      // Where `AccessDenied` lands. If this appears consistently after a
      // deploy, the cause is the IAM attachment — `prod:cover-letters` is a
      // grant that has to be applied, not only declared.
      return "Document storage is unavailable. Try again in a moment."

    default:
      return "Something went wrong."
  }
}
