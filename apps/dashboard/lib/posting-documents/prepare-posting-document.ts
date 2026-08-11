import { requireUser } from "@/lib/actions/require-user"
import { storageMessage } from "@/lib/actions/storage-message"
import type { CurrentUser } from "@/lib/auth/current-user"
import {
  loadCandidateBackground,
  type NoBackgroundReason,
} from "@/lib/candidate/candidate-background"
import {
  loadStoredPosting,
  storedPostingMessage,
} from "@/lib/postings/load-stored-posting"
import { assertDraftable, UndraftableError } from "@workspace/agents/draftable"
import type { StoredPosting } from "@workspace/agents/stored-posting"
import type { PrismaClient } from "@workspace/db"
import type { ResumeStore } from "@workspace/user-storage"
import { z } from "zod"

import { BAD_REQUEST, POSTING_ID_PATTERN } from "./posting-document-ref"

/**
 * Everything that has to be true before a model is asked to write a **Posting
 * Document**, in one call.
 *
 * ## Why this exists
 *
 * Drafting a Cover Letter and generating a Tailored Resume performed the same
 * five steps in the same order, and each of the five is a decision rather than
 * plumbing — the order in particular. Two copies meant two places to weaken
 * them, and the second was written by copying the first.
 *
 * ⚠️ **The order is the security and spending property, not an implementation
 * detail.** Who is asking is settled before the body is touched; the Posting is
 * re-read server-side rather than accepted from the form; and *every* refusal
 * happens before an agent is constructed, so a user with nothing to write from
 * costs no model call. A caller that reordered these would still compile, and
 * would still pass a happy-path test.
 *
 * ## What it deliberately does not do
 *
 * **It returns a reason, never a sentence** — except where the sentence already
 * has exactly one owner elsewhere (`requireUser`, `storedPostingMessage`,
 * `storageMessage`, {@link BAD_REQUEST}), in which case it is carried as
 * {@link RefusedDocument} and the caller passes it straight on. The two reasons a
 * *feature* has to word are the two returned bare: nothing to write from, and not
 * enough to write from. `suggest-criteria-actions.ts` argues at length why those
 * must not be shared — a letter with no CV and a resume with no CV are the same
 * condition told differently, because the next thing to do about them differs —
 * and this module is what lets them stay separate switches over one union.
 *
 * **It does not parse the request.** `CoverLetterRequestSchema` and
 * `TailoredResumeRequestSchema` are separate types in `@workspace/agents` and
 * stay that way; this returns the validated Posting and the extracted
 * background, and each feature composes its own request from them.
 *
 * **Nothing here imports Next**, which is the rule the whole of `lib/` follows.
 */

/** The one field either form is allowed to carry. */
const requestSchema = z.object({
  postingId: z.string().regex(POSTING_ID_PATTERN),
})

/** Everything the caller needs, once none of the refusals applied. */
export interface PreparedPostingDocument {
  ok: true
  /** From the session. Never a value that passed through the form. */
  userId: string
  postingId: string
  /** Read out of `postings.payload`, not out of the request. */
  posting: StoredPosting
  /**
   * The Run that most recently reported the advertisement, for provenance.
   *
   * `null` for a Posting the user added by pasting its link: no Run has ever
   * seen it, and there is nothing to name. A caller stamping provenance leaves
   * the field off rather than substituting a placeholder for it.
   */
  lastSeenRunId: string | null
  /** The candidate's own words, extracted from the Document they labelled. */
  background: string
  /** What that Document is called, for a message that names it. */
  displayName: string
}

/**
 * A refusal whose wording is already owned somewhere else.
 *
 * `requireUser` owns `NOT_AUTHORIZED`, `storedPostingMessage` owns the three
 * Posting outcomes, `storageMessage` owns the outage sentence, and
 * {@link BAD_REQUEST} names a Posting rather than a document. A feature that
 * re-worded any of these would be re-opening a decision made for it — and in two
 * of the four cases the identity of the string is a security property.
 */
interface RefusedDocument {
  ok: false
  reason: "refused"
  message: string
}

/** There is no Document to write from. The feature says what to do about it. */
interface NoBackgroundDocument {
  ok: false
  reason: "no-background"
  missing: NoBackgroundReason
}

/**
 * There is a Document, and it will not support an honest one.
 *
 * ⚠️ **Measured on the *extracted* text, not on the file** — which is why the
 * background is loaded and parsed before this runs rather than after. A 200 KB
 * PDF whose text layer is a name and a phone number is `too-short`.
 */
interface UndraftableDocument {
  ok: false
  reason: "undraftable"
  error: UndraftableError
  /** The Document that was tried, so the message can name it. */
  displayName: string
}

export type UnpreparedPostingDocument =
  RefusedDocument | NoBackgroundDocument | UndraftableDocument

export interface PreparePostingDocumentDeps {
  /** Who is asking. The seam that makes the auth branches testable. */
  getUser: () => Promise<CurrentUser>
  /** Resolved per call, so nothing is constructed at module scope. */
  getPrisma: () => PrismaClient
  /** Where the candidate's own document is read from. */
  getResumes: () => ResumeStore
}

export async function preparePostingDocument(
  deps: PreparePostingDocumentDeps,
  formData: FormData,
  /**
   * The object kind, for the server-side log line only.
   *
   * It reaches nothing the caller can be told apart by: both kinds deliberately
   * share one message per outcome, for the reason `storedPostingMessage` gives.
   */
  kind: string
): Promise<PreparedPostingDocument | UnpreparedPostingDocument> {
  const refused = (message: string): RefusedDocument => ({
    ok: false,
    reason: "refused",
    message,
  })

  // Before the body is touched at all. For a Server Action this is not a second
  // layer: `proxy.ts` cannot evaluate a POST session — the auth SDK's fast path
  // is guarded by `method === "GET"` — so it degrades to checking that some
  // session-cookie substring is present. This is the only real check on the path.
  const caller = await requireUser(deps.getUser, kind)
  if (!caller.ok) return refused(caller.message)

  // ⚠️ **Only this one field is read, and that is the security property.**
  // `formData` may well carry a `posting` — both suites submit one — and nothing
  // here looks at it. A Posting body accepted from a form would be arbitrary
  // text stored in a document written in the user's own name.
  const parsed = requestSchema.safeParse({
    postingId: formData.get("postingId"),
  })
  if (!parsed.success) return refused(BAD_REQUEST)

  const stored = await loadStoredPosting(
    deps.getPrisma(),
    caller.userId,
    parsed.data.postingId,
    kind
  )
  if (stored.status !== "found") return refused(storedPostingMessage(stored))

  // Before any agent is constructed, so a user with nothing to write from spends
  // nothing. This is also where a PDF or a DOCX is parsed — still on this side of
  // the model call, which is what keeps the bound below applying to the text that
  // was actually extracted.
  let background
  try {
    background = await loadCandidateBackground(
      caller.userId,
      deps.getPrisma(),
      deps.getResumes()
    )
  } catch (error) {
    return refused(storageMessage(`${kind}: read failed`, error))
  }

  if (!background.ok) {
    return { ok: false, reason: "no-background", missing: background.reason }
  }

  try {
    // Still before the model call. The question is the same for both kinds — is
    // there enough of this person's own document to work from? — so
    // `assertDraftable` is shared rather than restated; it takes a structural
    // `{ background }` for exactly that. A document written from too little is
    // not a thin one, it is a fabricated one.
    assertDraftable({ background: background.background })
  } catch (error) {
    if (error instanceof UndraftableError) {
      return {
        ok: false,
        reason: "undraftable",
        error,
        displayName: background.displayName,
      }
    }

    throw error
  }

  return {
    ok: true,
    userId: caller.userId,
    postingId: parsed.data.postingId,
    posting: stored.posting,
    lastSeenRunId: stored.lastSeenRunId,
    background: background.background,
    displayName: background.displayName,
  }
}
