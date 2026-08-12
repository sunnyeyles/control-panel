import type { DocumentType } from "@workspace/db"

/**
 * What each Document Type is called in the interface.
 *
 * One copy, read by the uploader's `<Select>`, the list's badge and the settings
 * picker. There were three, none tied to the canonical set, so a new type
 * rendered as its raw slug and was unofferable in the form — typechecking and
 * tests all green.
 *
 * ⚠️ **The import is `import type`, and that is load-bearing.** This module is
 * reached from a client component and `@workspace/db` carries the Prisma client
 * and `pg`; a type-only import is erased before bundling, while
 * `Record<DocumentType, …>` still makes the compiler insist the set is
 * exhaustive. Restating the keys is the price: importing `DOCUMENT_TYPES` as a
 * *value* would single-source them but rest the guarantee on a bundler
 * continuing to resolve a subpath that happens not to reach the driver.
 * `lib/postings/posting-status-labels.ts` is the same arrangement.
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
