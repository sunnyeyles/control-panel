import { storageMessage } from "@/lib/actions/storage-message"

import {
  preparePostingDocument,
  type PreparedPostingDocument,
  type PreparePostingDocumentDeps,
  type UnpreparedPostingDocument,
} from "./prepare-posting-document"

/**
 * Generating one **Posting Document** (prepare → produce → put), in one call.
 *
 * ## Why this exists
 *
 * Drafting a Cover Letter and generating a Tailored Resume performed the same
 * three steps after preparation in the same order, and the second was written
 * by copying the first. Preparation and editing already live in this folder;
 * generation was the remaining twin.
 *
 * ⚠️ **It returns a reason, never a sentence** — except where the sentence
 * already has exactly one owner elsewhere (`requireUser`, `storageMessage`,
 * {@link BAD_REQUEST} via prepare, or a feature's own `produce` failure). The
 * two reasons a *feature* has to word (`no-background`, `undraftable`) stay
 * bare so each feature keeps its own refusal table — CONTEXT forbids collapsing
 * those into one vague helper.
 *
 * ⚠️ **`produce` owns everything kind-specific:** request parse, letter
 * instructions (letters only), the model call, and the store-shaped payload
 * (`draftedAt` vs `generatedAt`, provenance fields). Failures that already have
 * a user sentence come back as `{ ok: false, message }` and surface as
 * `reason: "refused"`.
 *
 * **Nothing here imports Next**, which is the rule the whole of `lib/` follows.
 */

/**
 * The one method this needs of the store, stated structurally.
 *
 * Both facades satisfy it without being named — the same arrangement
 * `EditablePostingDocuments` uses.
 */
export interface GeneratablePostingDocuments<TNew> {
  put(document: TNew): Promise<unknown>
}

export type PostingDocumentGeneration =
  { ok: true; prepared: PreparedPostingDocument } | UnpreparedPostingDocument

export interface GeneratePostingDocumentOptions<TNew> {
  /**
   * The object kind, for the server-side log line only.
   *
   * It reaches nothing the caller can be told apart by.
   */
  kind: string
  /**
   * Feature-owned middle: request parse, optional instructions, model call,
   * and the store-shaped payload.
   */
  produce: (
    prepared: PreparedPostingDocument
  ) => Promise<{ ok: true; document: TNew } | { ok: false; message: string }>
  store: GeneratablePostingDocuments<TNew>
}

export async function generatePostingDocument<TNew>(
  deps: PreparePostingDocumentDeps,
  formData: FormData,
  { kind, produce, store }: GeneratePostingDocumentOptions<TNew>
): Promise<PostingDocumentGeneration> {
  const prepared = await preparePostingDocument(deps, formData, kind)
  if (!prepared.ok) return prepared

  const produced = await produce(prepared)
  if (!produced.ok) {
    return { ok: false, reason: "refused", message: produced.message }
  }

  try {
    await store.put(produced.document)
  } catch (error) {
    return {
      ok: false,
      reason: "refused",
      message: storageMessage(`${kind}: write failed`, error),
    }
  }

  return { ok: true, prepared }
}
