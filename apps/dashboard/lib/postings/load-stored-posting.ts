import { POSTING_NOT_FOUND } from "@/lib/actions/not-found"
import {
  StoredPostingSchema,
  type StoredPosting,
} from "@workspace/agents/stored-posting"
import { postingPayload, type PrismaClient } from "@workspace/db"

/**
 * Reading one owned Posting, for the actions that write a document about it.
 *
 * **Nothing here imports Next**, like everything else these actions are built
 * from.
 *
 * The shape is a security property rather than a convenience:
 *
 * 1. **The caller supplies one identifier and never a Posting.** A Posting body
 *    in form data would let someone put text of their choosing into a document
 *    stored in the user's own voice; it is re-read here from `payload`, which
 *    nothing on the client can write.
 * 2. **It is addressed by (session user, posting id)**, the natural key of
 *    `postings`, so a stranger's advertisement cannot be *named* rather than
 *    being named, loaded, then refused by a comparison somebody must remember to
 *    write. No window between a check and a read.
 *
 * ⚠️ **Read from `postings.payload`, never from `runs.findings`.** Recording
 * Postings and recording Findings are independent non-fatal steps, so a Run can
 * succeed with `findings` left NULL — a run id in the key would refuse an
 * advertisement plainly on screen. The Run survives as provenance on the stored
 * document and is no part of any key.
 *
 * ⚠️ **Shared, so a change here lands on every caller at once.** Both consumers
 * spend a model call downstream; loosening what this accepts loosens what they
 * will write a document from.
 *
 * The query is `postingPayload` in `@workspace/db`, shared with
 * `load-posting-detail.ts` (the two had drifted, `findFirst` vs `findUnique`).
 * What stays here is what the database cannot answer: parsing the payload
 * against a schema `@workspace/db` cannot see, and naming each failure.
 */

export type StoredPostingResult =
  | {
      status: "found"
      posting: StoredPosting
      /** NULL for a Posting the user added by link, which no Run has seen. */
      lastSeenRunId: string | null
    }
  | { status: "not-found" | "unreadable" | "failed" }

/**
 * The row is there and the Posting stored on it will not parse.
 *
 * `lib/postings/list-postings.ts` degrades such a row to its projected columns
 * and renders it anyway, so a Posting in this state is on the page and looks
 * ordinary. Here there is nothing to degrade to: `payload` *is* what the
 * document would be written from, and `title`/`company`/`location`/`url` are a
 * projection for a table rather than an advertisement. Refuse, and say which
 * half is missing rather than reporting it as a Posting nobody ever found.
 */
export const POSTING_UNREADABLE =
  "The details this posting was found with could not be read, so there is nothing to write from."

/**
 * Read one owned Posting and validate the payload written by its producer.
 *
 * `domain` only labels the server-side log line, so a failure says which feature
 * was asking. It reaches nothing the caller can be told apart by: the two
 * consumers deliberately share one message per outcome.
 */
export async function loadStoredPosting(
  prisma: PrismaClient,
  userId: string,
  postingId: string,
  domain: string
): Promise<StoredPostingResult> {
  let row
  try {
    row = await postingPayload(prisma, userId, postingId)
  } catch (error) {
    console.error(`${domain}: could not load the posting`, error)
    return { status: "failed" }
  }

  if (!row) return { status: "not-found" }

  const parsed = StoredPostingSchema.safeParse(row.payload)
  if (!parsed.success) {
    console.error(`${domain}: the stored posting is unreadable`, postingId)
    return { status: "unreadable" }
  }

  return {
    status: "found",
    posting: parsed.data,
    lastSeenRunId: row.lastSeenRunId,
  }
}

/**
 * What to tell the user, for each way the read did not produce a Posting.
 *
 * `POSTING_NOT_FOUND` covers both "no such Posting" and "someone else's", and
 * that identity is load-bearing: Posting ids are derived from an advertisement's
 * URL, so two messages would turn a form into an oracle for whether a stranger
 * has been shown it.
 */
export function storedPostingMessage(
  result: Exclude<StoredPostingResult, { status: "found" }>
): string {
  switch (result.status) {
    case "not-found":
      return POSTING_NOT_FOUND
    case "unreadable":
      return POSTING_UNREADABLE
    case "failed":
      return "Something went wrong."
    default: {
      const _exhaustive: never = result.status
      return _exhaustive
    }
  }
}
