import * as z from "zod"

import { PostingSchema } from "./findings.ts"

/**
 * What `postings.payload` may hold — a superset of what a Run writes.
 *
 * A Posting no longer arrives only one way. A Run's scout produces a
 * {@link ../findings.ts | Posting}, every field of it, because a scout was given
 * criteria and can say why an advertisement answers them. Somebody pasting a
 * link was given no criteria at all, so there is nothing for `matchReason` to be
 * — and inventing one is the fabrication this package refuses everywhere else.
 *
 * Hence two schemas rather than one relaxed schema. **The scout → brief-writer
 * contract stays strict**: `PostingSchema` still requires a match reason, and a
 * scout that omits one is still a malformed hand-off. What widens is only the
 * shape a *reader* of the stored row will accept, which is this one. Every
 * dashboard read path parses against it; nothing that validates an agent's
 * output does.
 *
 * The direction matters and is the reason this is an `.extend()` rather than a
 * hand-written twin: a `Posting` is always a valid `StoredPosting`, so a Run's
 * payload needs no conversion, and adding a field to the contract adds it here
 * with no second edit.
 */
export const StoredPostingSchema = PostingSchema.extend({
  matchReason: z
    .string()
    .optional()
    .describe(
      "One sentence on why this fits the candidate's criteria. Absent on a Posting the user added by pasting its link, which was matched against no criteria."
    ),
})

export type StoredPosting = z.infer<typeof StoredPostingSchema>
