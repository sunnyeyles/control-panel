import type { PostingDetailView } from "@/lib/postings/load-posting-detail"

/**
 * One row's detail, as the table body holds it.
 *
 * Lives beside the panel rather than beside the fetch because this is the type
 * the three states are *for*: the panel renders one branch each, and a fourth
 * state would have to earn a branch here to exist at all.
 */
export type PostingDetailState =
  | { status: "loading" }
  | { status: "ready"; view: PostingDetailView }
  | { status: "failed"; message: string }
