import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { parseFindings, type Findings } from "@workspace/agents"
import { createBriefStore } from "@workspace/user-storage"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createDirectoryObjectStore,
  createFindingsFileRecorder,
} from "./stores.ts"

/**
 * The harness is what gives the `letter` CLI real input to read, with no S3 and
 * no database anywhere in the loop. What that needs is one property: the
 * findings land beside the brief, and they land as something `parseFindings`
 * accepts — the same function the worker validates the scout's hand-off with.
 */

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const USER_ID = "33333333-3333-4333-8333-333333333333"
/** 23:30 UTC, so the partition day is the occurrence's, not the finish time's. */
const OCCURRENCE = new Date("2026-08-03T23:30:00.000Z")

const FINDINGS: Findings = {
  postings: [
    {
      title: "Senior Backend Engineer",
      company: "Morgan McKinley",
      location: "Sydney NSW (Hybrid)",
      url: "https://www.seek.com.au/job/93431609",
      highlights: ["Own async pipelines & AWS infra - queues, workers"],
      summary: "A backend role on a real-time data product.",
      matchReason: "Backend, Sydney, Python and AWS.",
    },
  ],
  notes: "One source only.",
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "briefing-harness-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("createFindingsFileRecorder", () => {
  it("writes the findings beside the brief the same run produced", async () => {
    const objects = createDirectoryObjectStore({ directory })
    const recordFindings = createFindingsFileRecorder({
      directory,
      userId: USER_ID,
      occurrence: OCCURRENCE,
    })

    await createBriefStore(objects).put({
      userId: USER_ID,
      briefId: RUN_ID,
      occurrence: OCCURRENCE,
      generatedAt: new Date("2026-08-04T00:10:00.000Z"),
      markdown: "# Brief\n",
    })
    await recordFindings(RUN_ID, FINDINGS)

    const brief = objects.written[0]
    const findings = recordFindings.written[0]

    expect(brief).toBeDefined()
    expect(findings).toBeDefined()
    // The property this harness needs is co-location, not the key layout: both
    // writes derive their directory from the same occurrence, so the findings
    // sit beside the brief. What that directory looks like — the partitioning
    // on the occurrence's day, not the finish time's — is the brief key's own
    // contract, pinned in `packages/user-storage/src/facades.test.ts`.
    expect(dirname(findings ?? "")).toBe(dirname(brief ?? ""))
    expect(basename(findings ?? "")).toBe(`${RUN_ID}.json`)
  })

  it("writes findings the worker's own parser accepts", async () => {
    const recordFindings = createFindingsFileRecorder({
      directory,
      userId: USER_ID,
      occurrence: OCCURRENCE,
    })

    await recordFindings(RUN_ID, FINDINGS)

    const path = recordFindings.written[0] ?? ""
    const parsed = parseFindings(await readFile(path, "utf8"))

    expect(parsed).toEqual(FINDINGS)
  })

  it("refuses a userId that would address another prefix", async () => {
    const recordFindings = createFindingsFileRecorder({
      directory,
      userId: "../someone-else",
      occurrence: OCCURRENCE,
    })

    // Not a tidiness check: the segment rule in `@workspace/user-storage` is
    // the ownership boundary, and the recorder derives its path through
    // `buildObjectKey` rather than by joining strings so that it applies here
    // too.
    await expect(recordFindings(RUN_ID, FINDINGS)).rejects.toThrow()
    expect(recordFindings.written).toEqual([])
  })
})
