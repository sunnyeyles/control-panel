import type { DocumentType } from "@workspace/db"

/**
 * What each Document Type is called in the interface.
 *
 * One copy, read by the uploader's `<Select>`, the list's badge and the
 * settings picker. There were three — this map, an options array in
 * `document-uploader.tsx`, and a `Record<string, string>` in
 * `document-list.tsx` — and nothing tied any of them to the canonical set. A
 * new type added there would have rendered as its raw slug in the list and been
 * unofferable in the form, with everything still typechecking and every test
 * still passing.
 *
 * ⚠️ **The import is `import type`, and that is load-bearing.** This module is
 * reached from a client component, and `@workspace/db` carries the Prisma
 * client and `pg`. A type-only import is erased before bundling, so the labels
 * cost the browser nothing while `Record<DocumentType, …>` still makes the
 * compiler insist the set is exhaustive — which is the whole point. Restating
 * the keys is the price of that, and it is the right trade: importing
 * `DOCUMENT_TYPES` as a *value* would single-source them, but the guarantee
 * would then rest on a bundler continuing to resolve a package subpath to a
 * module that happens not to reach the driver, which is a weaker thing to
 * depend on than an import the compiler erases unconditionally.
 * `lib/postings/posting-status-labels.ts` is the same arrangement over
 * `PostingStatus`, for the same reason.
 */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  resume: "Resume",
  "cover-letter": "Cover letter",
  portfolio: "Portfolio",
  reference: "Reference",
  certification: "Certification",
  // Not filler. Without it a document that is none of the other five has to be
  // mislabelled as one of them, and a label nobody trusts is worse than none.
  other: "Other",
}
