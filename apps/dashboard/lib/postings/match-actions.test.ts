import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import { matchesPostingWhere, type PostingWhere } from "@/lib/dev/fake-prisma"
import { fakeDocumentDb } from "@/lib/test-support/fake-document-db"
import { FakeResumes } from "@/lib/test-support/fake-resumes"
import {
  ANONYMOUS,
  REFUSED,
  SIGNED_IN,
  USER_ID,
} from "@/lib/test-support/identities"
import type { Agent } from "@workspace/agents"
import type { PrismaClient } from "@workspace/db"
import { beforeEach, describe, expect, it } from "vitest"

import { createMatchActions, MATCH_BATCH } from "./match-actions"

/**
 * Scoring Postings against the CV, and everything it refuses to do first.
 *
 * ⚠️ **`assessorBuilds` is the assertion that matters most in this file**, for
 * the reason `suggest-criteria-actions.test.ts` gives about its own: it counts
 * calls to the injected *factory*, not calls to `invoke()`, because the property
 * being defended is about spending. Constructing an assessor is what commits to
 * a model, and every refusal must happen strictly before it. An assertion on the
 * prompts alone would pass for an implementation that built an agent and then
 * decided not to use it.
 *
 * The other property with no happy path is the batch's independence: this action
 * makes several model calls at once, and one of them failing must cost one row
 * rather than the round.
 */

const NOW = new Date("2026-08-05T04:15:00.000Z")
const SCORED_AT = new Date("2026-08-06T00:00:00.000Z")

const RESUME_ID = "11111111-1111-4111-8111-111111111111"
const OLDER_RESUME_ID = "22222222-2222-4222-8222-222222222222"

/** Comfortably over `MIN_BACKGROUND_CHARS`, so `assertDraftable` passes. */
const CV = [
  "# Alice Example",
  "",
  "Backend engineer, eight years. Built and ran payment services on Node and",
  "Postgres at Northwind, then led the migration of a monolith to a set of",
  "services at Contoso. Comfortable with TypeScript, Go, Terraform and AWS.",
  "Mentored four juniors. Based in Sydney and looking for backend work with",
  "some infrastructure in it.",
].join("\n")

/** What a well-behaved assessor answers with: JSON and nothing else. */
const MATCH = JSON.stringify({
  score: 76,
  reason: "Go and Postgres line up; the payments domain is the stretch.",
  gaps: ["Kubernetes in production"],
})

/** A row of the fake `postings` table. Only the columns this path reads. */
interface FakePosting {
  userId: string
  postingId: string
  payload: unknown
  lastSeenAt: Date
  matchScore: number | null
  matchReason: string | null
  matchGaps: unknown
  matchResumeId: string | null
  matchedAt: Date | null
}

function aPosting(
  postingId: string,
  overrides: Partial<FakePosting> = {}
): FakePosting {
  return {
    userId: USER_ID,
    postingId,
    payload: {
      title: `Backend Engineer ${postingId}`,
      company: "Meridian Systems",
      location: "Sydney NSW",
      url: `https://www.seek.com.au/job/${postingId}`,
      summary: "Payment services on a small platform team.",
      matchReason: "Backend and Sydney.",
    },
    lastSeenAt: NOW,
    matchScore: null,
    matchReason: null,
    matchGaps: null,
    matchResumeId: null,
    matchedAt: null,
    ...overrides,
  }
}

/** Sixteen lowercase hex characters, which is the shape `postingId()` makes. */
function derivedId(index: number): string {
  return index.toString(16).padStart(16, "0")
}

/**
 * A `postings` table, for this action's four calls.
 *
 * ⚠️ **The `where` is answered through `matchesPostingWhere`, shared with the
 * dev fake rather than restated.** Two spellings of "which rows does this
 * `where` name" is one more than the number that can be wrong without anybody
 * noticing — and here the predicate is the entire staleness rule, so a double
 * that agreed with nothing would make the loop look correct while scoring the
 * wrong rows.
 */
class FakePostings {
  readonly writes: {
    postingId: string
    data: Record<string, unknown>
  }[] = []

  constructor(readonly rows: FakePosting[]) {}

  asPrisma(documents: PrismaClient): PrismaClient {
    return {
      ...documents,
      posting: {
        count: async (query: { where: PostingWhere }) =>
          this.matching(query.where).length,

        findMany: async (query: {
          where: PostingWhere
          orderBy?: unknown
          take?: number
        }) =>
          this.matching(query.where)
            .sort(
              (left, right) =>
                right.lastSeenAt.getTime() - left.lastSeenAt.getTime()
            )
            .slice(0, query.take)
            .map((row) => ({ postingId: row.postingId })),

        // Both halves of the natural key, because that pair *is* the ownership
        // check — a double answering from `postingId` alone would let the real
        // read stop scoping with every test still green.
        findUnique: async (query: {
          where: { userId_postingId: { userId: string; postingId: string } }
        }) => {
          const key = query.where.userId_postingId
          const found = this.rows.find(
            (row) =>
              row.userId === key.userId && row.postingId === key.postingId
          )

          return found ?? null
        },

        updateMany: async (query: {
          where: { userId: string; postingId: string }
          data: Record<string, unknown>
        }) => {
          const row = this.rows.find(
            (candidate) =>
              candidate.userId === query.where.userId &&
              candidate.postingId === query.where.postingId
          )
          if (!row) return { count: 0 }

          this.writes.push({
            postingId: query.where.postingId,
            data: query.data,
          })
          Object.assign(row, query.data)

          return { count: 1 }
        },
      },
    } as unknown as PrismaClient
  }

  private matching(where: PostingWhere): FakePosting[] {
    return this.rows.filter((row) => matchesPostingWhere(row, where))
  }
}

/**
 * A stand-in for the assessor.
 *
 * Cast to `Agent` rather than built with `createMatchAssessor`, which would need
 * a LangChain chat model this app does not depend on. What the real agent does
 * with a prompt — and that it holds no tools — is asserted in
 * `packages/agents`; what matters here is whether it is reached at all, and what
 * the action does with what comes back.
 */
class FakeAssessor {
  readonly prompts: string[] = []
  /** Keyed by a fragment of the prompt, so one posting can be made to fail. */
  replies = new Map<string, string>()
  reply = MATCH

  async invoke(input: {
    messages: { content: string }[]
  }): Promise<{ messages: { text: string }[] }> {
    const prompt = input.messages.map((message) => message.content).join("\n")
    this.prompts.push(prompt)

    for (const [fragment, reply] of this.replies) {
      if (prompt.includes(fragment)) return { messages: [{ text: reply }] }
    }

    return { messages: [{ text: this.reply }] }
  }

  asAgent(): Agent {
    return this as unknown as Agent
  }
}

interface Harness {
  score: () => ReturnType<
    ReturnType<typeof createMatchActions>["scorePendingMatches"]
  >
  postings: FakePostings
  assessor: FakeAssessor
  /** How many times the factory was called. The spend assertion. */
  assessorBuilds: () => number
}

function harness(
  options: {
    user?: CurrentUser
    resumes?: FakeResumes
    rows?: FakePosting[]
  } = {}
): Harness {
  const resumes =
    options.resumes ??
    new FakeResumes(CV, NOW).add({
      resumeId: RESUME_ID,
      extension: ".md",
      documentType: "resume",
      originalFilename: "alice-cv.md",
    })

  const postings = new FakePostings(
    options.rows ?? [aPosting(derivedId(1)), aPosting(derivedId(2))]
  )
  const assessor = new FakeAssessor()
  let builds = 0

  const actions = createMatchActions({
    getUser: async () => options.user ?? SIGNED_IN,
    getResumes: () => resumes,
    getPrisma: () => postings.asPrisma(fakeDocumentDb(USER_ID, resumes.rows)),
    createAssessor: () => {
      builds += 1
      return assessor.asAgent()
    },
    now: () => SCORED_AT,
  })

  return {
    score: actions.scorePendingMatches,
    postings,
    assessor,
    assessorBuilds: () => builds,
  }
}

let subject: Harness

beforeEach(() => {
  subject = harness()
})

describe("scorePendingMatches", () => {
  describe("who is asking", () => {
    it("refuses an anonymous caller and builds no assessor", async () => {
      subject = harness({ user: ANONYMOUS })

      expect(await subject.score()).toEqual({
        status: "error",
        message: NOT_AUTHORIZED,
      })
      // ⚠️ Not merely refused — refused before a model existed. A signed-out
      // POST to this endpoint must not be a way to spend the OpenAI budget.
      expect(subject.assessorBuilds()).toBe(0)
      expect(subject.postings.writes).toHaveLength(0)
    })

    it("gives a signed-in-but-unapproved caller the same message", async () => {
      subject = harness({ user: REFUSED })

      expect(await subject.score()).toEqual({
        status: "error",
        message: NOT_AUTHORIZED,
      })
      expect(subject.assessorBuilds()).toBe(0)
    })
  })

  describe("there is nothing to score against", () => {
    it("says so when nothing is labelled a resume, and builds no assessor", async () => {
      subject = harness({
        resumes: new FakeResumes(CV, NOW).add({
          resumeId: OLDER_RESUME_ID,
          extension: ".md",
          documentType: "cover-letter",
        }),
      })

      const result = await subject.score()

      expect(result.status).toBe("unavailable")
      expect(subject.assessorBuilds()).toBe(0)
      expect(subject.postings.writes).toHaveLength(0)
    })

    it("says so when the resume is too thin to judge anything against", async () => {
      subject = harness({
        resumes: new FakeResumes("Alice.", NOW).add({
          resumeId: RESUME_ID,
          extension: ".md",
          documentType: "resume",
          originalFilename: "alice-cv.md",
        }),
      })

      const result = await subject.score()

      expect(result.status).toBe("unavailable")
      // The bound is `assertDraftable`'s, reused rather than restated — and it
      // is checked before an assessor exists, like every other refusal.
      expect(subject.assessorBuilds()).toBe(0)
    })
  })

  describe("scoring", () => {
    it("writes a score, its reason, its gaps and the document it was scored against", async () => {
      const result = await subject.score()

      expect(result).toEqual({ status: "success", scored: 2, remaining: 0 })
      expect(subject.postings.writes).toHaveLength(2)
      expect(subject.postings.writes[0]?.data).toEqual({
        matchScore: 76,
        matchReason:
          "Go and Postgres line up; the payments domain is the stretch.",
        matchGaps: ["Kubernetes in production"],
        // ⚠️ **The document `loadCandidateBackground` actually read**, not a
        // name and not a guess. It is the whole of how a score goes stale: a
        // value other than the user's current resume means the score describes
        // a CV they have replaced.
        matchResumeId: RESUME_ID,
        matchedAt: SCORED_AT,
      })
    })

    it("shows the assessor the advertisement and the CV, and nothing from a request", async () => {
      await subject.score()

      for (const prompt of subject.assessor.prompts) {
        expect(prompt).toContain(CV)
        expect(prompt).toContain("Payment services on a small platform team.")
      }
    })

    it("leaves a Posting already scored against the current resume alone", async () => {
      subject = harness({
        rows: [
          aPosting(derivedId(1), {
            matchScore: 40,
            matchReason: "Scored earlier.",
            matchGaps: [],
            matchResumeId: RESUME_ID,
            matchedAt: NOW,
          }),
          aPosting(derivedId(2)),
        ],
      })

      const result = await subject.score()

      expect(result).toMatchObject({ scored: 1 })
      expect(subject.postings.writes.map((write) => write.postingId)).toEqual([
        derivedId(2),
      ])
    })

    /**
     * ⚠️ **Both arms of the staleness rule, and the NULL one is the easy one to
     * lose.** A Posting nobody has scored and a Posting scored against a CV the
     * user has since replaced both want scoring; a plain inequality would
     * silently skip the first, which is every row on a first visit.
     */
    it("re-scores a Posting scored against a resume the user has replaced", async () => {
      subject = harness({
        rows: [
          aPosting(derivedId(1), {
            matchScore: 40,
            matchReason: "Scored against the old CV.",
            matchGaps: [],
            matchResumeId: OLDER_RESUME_ID,
            matchedAt: NOW,
          }),
        ],
      })

      expect(await subject.score()).toMatchObject({ scored: 1 })
      expect(subject.postings.writes[0]?.data).toMatchObject({
        matchScore: 76,
        matchResumeId: RESUME_ID,
      })
    })

    it("bounds one call, and reports how many are left", async () => {
      const rows = Array.from({ length: MATCH_BATCH + 3 }, (_, index) =>
        aPosting(derivedId(index + 1))
      )
      subject = harness({ rows })

      const result = await subject.score()

      expect(result).toEqual({
        status: "success",
        scored: MATCH_BATCH,
        remaining: 3,
      })
      expect(subject.assessor.prompts).toHaveLength(MATCH_BATCH)
    })
  })

  /**
   * ⚠️ **The property `Promise.allSettled` exists for.** These are independent
   * model calls over independent advertisements; one answering with something
   * that is not a match must cost its own row and nothing else. The failed row
   * stays unscored, which is exactly the state the next round looks for.
   */
  describe("one posting failing", () => {
    it("does not cost the rest of the batch", async () => {
      subject.assessor.replies.set(
        `Backend Engineer ${derivedId(1)}`,
        "I would say about a seven out of ten."
      )

      const result = await subject.score()

      expect(result).toMatchObject({ status: "success", scored: 1 })
      expect(subject.postings.writes.map((write) => write.postingId)).toEqual([
        derivedId(2),
      ])
    })

    it("leaves the failed row unscored, so the next round tries it again", async () => {
      subject.assessor.replies.set(`Backend Engineer ${derivedId(1)}`, "{}")

      await subject.score()

      const failed = subject.postings.rows.find(
        (row) => row.postingId === derivedId(1)
      )
      expect(failed?.matchScore).toBeNull()
      expect(failed?.matchResumeId).toBeNull()
    })
  })

  it("does nothing at all, cheaply, when everything is already scored", async () => {
    subject = harness({
      rows: [
        aPosting(derivedId(1), {
          matchScore: 80,
          matchReason: "Scored.",
          matchGaps: [],
          matchResumeId: RESUME_ID,
          matchedAt: NOW,
        }),
      ],
    })

    expect(await subject.score()).toEqual({
      status: "success",
      scored: 0,
      remaining: 0,
    })
    // The page mounts the loop on every visit, so this is the common path — and
    // it must not build a model to discover there is nothing to do.
    expect(subject.assessorBuilds()).toBe(0)
  })
})
