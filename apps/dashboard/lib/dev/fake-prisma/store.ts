import {
  devCoverLetterInstructions,
  devDocuments,
  devJobs,
  devPostings,
  devRuns,
} from "@/lib/dev/fixtures"
import type {
  Board,
  CoverLetterInstructions,
  Document,
  Job,
  Posting,
  PostingFilters,
  Run,
} from "@workspace/db"

/**
 * Plain data holder for the in-memory store. No domain logic — each delegate
 * reads and mutates these arrays directly.
 */
export interface DevStore {
  readonly jobs: Job[]
  readonly runs: Run[]
  readonly coverLetterInstructions: CoverLetterInstructions[]
  readonly postings: Posting[]
  readonly documents: Document[]
  readonly postingFilters: PostingFilters[]
  board: Board | undefined
  nextId: number
}

export function createDevStore(): DevStore {
  return {
    jobs: devJobs(),
    runs: devRuns(),
    coverLetterInstructions: devCoverLetterInstructions(),
    postings: devPostings(),
    documents: devDocuments(),
    /**
     * No fixture, and that is the useful starting point: an unfiltered table is
     * what every other dev assertion about `/jobs` assumes, and a canned
     * blocklist would silently hide fixture rows somebody is counting.
     */
    postingFilters: [],
    /** No fixture — the dev whiteboard starts empty. */
    board: undefined,
    nextId: 1,
  }
}
