import type { DocumentType } from "@workspace/user-storage"

/**
 * What each document type is called in the interface.
 *
 * One copy, read by both the uploader's `<Select>` and the list's badge. There
 * were three — this map, an options array in `document-uploader.tsx`, and a
 * `Record<string, string>` in `document-list.tsx` — and nothing tied any of
 * them to the five values in `@workspace/user-storage`. A sixth type added
 * there would have rendered as its raw slug in the list and been unofferable in
 * the form, with everything still typechecking and every test still passing.
 *
 * ⚠️ **The import is `import type`, and that is load-bearing.** This module is
 * reached from a client component, and `@workspace/user-storage` carries the
 * AWS SDK. A type-only import is erased before bundling, so the labels cost the
 * browser nothing while `Record<DocumentType, …>` still makes the compiler
 * insist the set is exhaustive — which is the whole point. Importing
 * `DOCUMENT_TYPES` as a *value* to derive the keys would work and would ship
 * the SDK to the browser.
 */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  resume: "Resume",
  "cover-letter": "Cover letter",
  portfolio: "Portfolio",
  reference: "Reference",
  // Not filler. Without it a document that is none of the first four has to be
  // mislabelled as one of them, and a label nobody trusts is worse than none.
  other: "Other",
}

/**
 * The types in the order the form offers them, as `<Select>` items.
 *
 * Derived from the map rather than written out again, so the order is the only
 * thing this adds. `Object.entries` on a `Record<DocumentType, string>` widens
 * the key back to `string`, hence the cast — the exhaustiveness that matters is
 * already enforced on the map above.
 */
export const DOCUMENT_TYPE_OPTIONS = Object.entries(DOCUMENT_TYPE_LABELS).map(
  ([value, label]) => ({ value: value as DocumentType, label })
)
