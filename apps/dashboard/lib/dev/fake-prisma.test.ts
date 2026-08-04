import { createDevPrisma } from "@/lib/dev/fake-prisma"
import {
  DEV_JOB_ACTIVE_ID,
  DEV_JOB_PAUSED_ID,
  DEV_USER_ID,
} from "@/lib/dev/fixtures"
import { listPostings } from "@/lib/postings/list-postings"
import { parsePostingQuery } from "@/lib/postings/posting-query"
import {
  coverLetterInstructions,
  pauseJob,
  resumeJob,
  saveCoverLetterInstructions,
  setPostingStatus,
  updateJobSchedule,
} from "@workspace/db"
import { describe, expect, it } from "vitest"

const STRANGER = "00000000-0000-4000-8000-000000000999"

/**
 * Driven through the real consumers, not raw Prisma calls: they are what talks
 * to this fake in the running app, and `updateJobSchedule` in particular reaches
 * it through `$executeRaw`. Otherwise this would only test the fake agreeing
 * with itself.
 */

describe("the DEV_AUTH_BYPASS fake database", () => {
  it("scopes postings to the user asking", async () => {
    const prisma = createDevPrisma()
    const query = parsePostingQuery()

    expect(
      (await listPostings(prisma, DEV_USER_ID, query)).total
    ).toBeGreaterThan(0)
    expect(await listPostings(prisma, STRANGER, query)).toMatchObject({
      total: 0,
      postings: [],
    })
  })

  /**
   * The fixture is deliberately larger than one page, because a fake that
   * ignored `skip` and `take` would make every page identical and look right.
   */
  it("pages the postings table", async () => {
    const prisma = createDevPrisma()

    const first = await listPostings(prisma, DEV_USER_ID, parsePostingQuery())
    const second = await listPostings(
      prisma,
      DEV_USER_ID,
      parsePostingQuery({ page: "2" })
    )

    expect(first.pageCount).toBeGreaterThan(1)
    expect(first.postings).toHaveLength(first.pageSize)
    expect(second.postings.length).toBeGreaterThan(0)
    expect(second.postings.length).toBeLessThan(first.pageSize)

    // No row on two pages, and none skipped between them.
    const ids = [...first.postings, ...second.postings].map((row) => row.id)
    expect(new Set(ids).size).toBe(first.total)
  })

  /**
   * ⚠️ The property the fake was changed for. `orderBy` used to be ignored
   * outright, which with sortable columns is a silent wrong-order bug in
   * exactly the environment the table is built in.
   */
  it("orders the postings table for real, both ways", async () => {
    const prisma = createDevPrisma()

    const ascending = await listPostings(
      prisma,
      DEV_USER_ID,
      parsePostingQuery({ sort: "title" })
    )
    const descending = await listPostings(
      prisma,
      DEV_USER_ID,
      parsePostingQuery({ sort: "title", dir: "desc" })
    )

    const titles = ascending.postings.map((row) => row.title)
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)))
    expect(descending.postings[0]?.title).not.toBe(titles[0])

    // A different column really is a different order, rather than the fixture
    // agreeing with itself.
    const byLastSeen = await listPostings(
      prisma,
      DEV_USER_ID,
      parsePostingQuery()
    )
    expect(byLastSeen.postings.map((row) => row.title)).not.toEqual(titles)
  })

  it("keeps a status change across reads, and refuses another user's row", async () => {
    const prisma = createDevPrisma()
    const [first] = (
      await listPostings(prisma, DEV_USER_ID, parsePostingQuery())
    ).postings

    if (!first) throw new Error("expected a seeded posting")

    expect(
      await setPostingStatus(prisma, DEV_USER_ID, first.id, "applied")
    ).toBe(true)
    expect(await setPostingStatus(prisma, STRANGER, first.id, "applied")).toBe(
      false
    )

    const reread = await listPostings(prisma, DEV_USER_ID, parsePostingQuery())
    expect(reread.postings.find((row) => row.id === first.id)?.status).toBe(
      "applied"
    )
  })

  it("keeps a pause across reads", async () => {
    const prisma = createDevPrisma()

    expect(await pauseJob(prisma, DEV_JOB_ACTIVE_ID)).toMatchObject({
      nextRunAt: null,
    })
    expect(
      await prisma.job.findUnique({ where: { id: DEV_JOB_ACTIVE_ID } })
    ).toMatchObject({ nextRunAt: null })
  })

  it("computes a fresh occurrence when a briefing is resumed", async () => {
    const prisma = createDevPrisma()
    const now = new Date("2026-08-04T12:00:00.000Z")

    const resumed = await resumeJob(prisma, DEV_JOB_PAUSED_ID, now)

    expect(resumed?.nextRunAt?.getTime()).toBeGreaterThan(now.getTime())
  })

  it("returns undefined rather than throwing for a job that is gone", async () => {
    const prisma = createDevPrisma()

    expect(await pauseJob(prisma, STRANGER)).toBeUndefined()
  })

  /** Fails loudly if the raw statement in packages/db/src/jobs.ts changes. */
  it("writes a new schedule through $executeRaw", async () => {
    const prisma = createDevPrisma()

    const updated = await updateJobSchedule(prisma, DEV_JOB_ACTIVE_ID, {
      cron: "0 */3 * * *",
      timezone: "UTC",
    })

    expect(updated?.scheduleCron).toBe("0 */3 * * *")
  })

  /** The `CASE`: rescheduling a paused briefing must not put it back on duty. */
  it("leaves a paused briefing paused when its schedule changes", async () => {
    const prisma = createDevPrisma()

    const updated = await updateJobSchedule(prisma, DEV_JOB_PAUSED_ID, {
      cron: "0 */12 * * *",
      timezone: "UTC",
    })

    expect(updated?.scheduleCron).toBe("0 */12 * * *")
    expect(updated?.nextRunAt).toBeNull()
  })

  it("serves the seeded cover letter instructions", async () => {
    const prisma = createDevPrisma()

    const saved = await coverLetterInstructions(prisma, DEV_USER_ID)

    expect(saved?.instructions).toMatch(/passionate/)
    // The fact the CV does not carry. Ticket 02's acceptance criterion is
    // checked by hand against this employer, so losing it from the fixture
    // would quietly make the check unfalsifiable.
    expect(saved?.exampleLetter).toMatch(/Brightwater Systems/)
  })

  it("has no instructions for a user who never saved any", async () => {
    const prisma = createDevPrisma()

    expect(await coverLetterInstructions(prisma, STRANGER)).toBeUndefined()
  })

  it("creates a row on the first save and replaces it on the next", async () => {
    const prisma = createDevPrisma()
    const stranger = STRANGER

    await saveCoverLetterInstructions(prisma, stranger, {
      instructions: "Sign off with Kind regards.",
      exampleLetter: "",
    })
    expect(await coverLetterInstructions(prisma, stranger)).toMatchObject({
      instructions: "Sign off with Kind regards.",
      exampleLetter: "",
    })

    await saveCoverLetterInstructions(prisma, stranger, {
      instructions: "No bullet points.",
      exampleLetter: "Dear Hiring Team,\n",
    })
    expect(await coverLetterInstructions(prisma, stranger)).toMatchObject({
      instructions: "No bullet points.",
      exampleLetter: "Dear Hiring Team,\n",
    })
  })

  it("keeps a saved instruction across reads", async () => {
    const prisma = createDevPrisma()

    await saveCoverLetterInstructions(prisma, DEV_USER_ID, {
      instructions: "Two paragraphs, no more.",
      exampleLetter: "",
    })

    expect(
      (await coverLetterInstructions(prisma, DEV_USER_ID))?.instructions
    ).toBe("Two paragraphs, no more.")
  })

  it("names an unimplemented query instead of answering undefined", () => {
    const prisma = createDevPrisma()

    expect(() => prisma.artifact).toThrow(/prisma\.artifact/)
    expect(() => prisma.job.deleteMany).toThrow(/prisma\.job\.deleteMany/)
  })

  /**
   * The property the whole fake rests on, asserted on the newest delegate:
   * a model being present must not make its missing methods answer `undefined`.
   */
  it("still throws by name on an unimplemented cover-letter query", () => {
    const prisma = createDevPrisma()

    expect(() => prisma.coverLetterInstructions.delete).toThrow(
      expect.objectContaining({
        name: "DevPrismaError",
        message: expect.stringContaining(
          "prisma.coverLetterInstructions.delete"
        ),
      })
    )
  })
})
