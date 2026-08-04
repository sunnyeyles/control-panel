import type { CurrentUser } from "@/lib/auth/current-user"
import type { Posting } from "@workspace/agents/findings"
import { postingId } from "@workspace/agents/posting-id"
/**
 * ⚠️ **Value imports use subpaths, not the barrels.** `current-user.ts` imports
 * `DEV_USER` from here and runs on every request, so the barrels would put
 * `@aws-sdk/client-s3` and `pg` on the production graph for a fixture. Types may
 * stay on the barrel — they are erased.
 */
import { computeNextRunAt } from "@workspace/db/schedule"
import type { Job, Run } from "@workspace/db/types"
import { contentTypeFor } from "@workspace/user-storage/kinds"
import type { NewCoverLetter, NewResume } from "@workspace/user-storage"

/**
 * The world `DEV_AUTH_BYPASS=1` renders.
 *
 * Picked to exercise branches, not to look plausible: one briefing paused
 * (`nextRunAt: null` is the only thing that makes `enabled` false), one on a
 * cron the picker cannot express (draws the "set outside the app" warning), one
 * posting with no `postedAt` and one with no `highlights`, and one cover letter
 * matching a posting plus one orphan. A fixture where every field is present
 * proves nothing about the optional ones.
 *
 * Dates are fixed so renders are deterministic, except `nextRunAt` — see
 * {@link devJobs}.
 */

/** Fixed so every id derived from it — S3 keys included — is stable. */
export const DEV_USER_ID = "3f8d1b2a-0000-4000-8000-000000000001"

const SEEDED_AT = new Date("2026-08-01T00:00:00.000Z")
const RAN_AT = new Date("2026-08-03T09:00:00.000Z")

/**
 * The session every request gets under the flag.
 *
 * `userId` is a `users.id`-shaped uuid, never a Neon Auth id — it becomes the
 * `userId` segment of every S3 key, exactly as the real one does.
 */
export const DEV_USER: CurrentUser = {
  status: "ok",
  userId: DEV_USER_ID,
  email: "dev@localhost",
  name: "Dev User",
}

const DAILY_CRON = "0 0 * * *"

/** Deliberately unexpressible by the interval picker. */
const HAND_WRITTEN_CRON = "0 3 1 1 *"

export const DEV_JOB_ACTIVE_ID = "3f8d1b2a-0000-4000-8000-0000000000a1"
export const DEV_JOB_PAUSED_ID = "3f8d1b2a-0000-4000-8000-0000000000a2"

const DEV_RUN_ACTIVE_ID = "3f8d1b2a-0000-4000-8000-0000000000b1"
const DEV_RUN_PAUSED_ID = "3f8d1b2a-0000-4000-8000-0000000000b2"

/**
 * Typed as `Posting`, not inferred: it checks these against the scout's schema,
 * and an `as const` would make the arrays `readonly` — which Prisma's
 * `JsonValue` rejects.
 */
const MERIDIAN: Posting = {
  title: "Senior Backend Engineer",
  company: "Meridian Freight",
  location: "Sydney, NSW (Hybrid)",
  url: "https://www.seek.com.au/job/dev-fixture-1",
  postedAt: "2 days ago",
  highlights: [
    "Own the services behind our container-tracking platform",
    "TypeScript and Postgres, deployed on AWS",
    "Four days on site during onboarding, two thereafter",
  ],
  summary:
    "Backend work on the systems that track freight from port to depot. The team is six engineers and owns its own deployments.",
  matchReason: "Matches your backend engineer title in Sydney.",
}

/** No `postedAt`: the advertisement did not say, which is the common case. */
const NORTHWIND: Posting = {
  title: "Platform Engineer",
  company: "Northwind Health",
  location: "Remote (Australia)",
  url: "https://www.seek.com.au/job/dev-fixture-2",
  highlights: [
    "Kubernetes, Terraform, and a small amount of Go",
    "Fully remote within Australia",
  ],
  summary:
    "Platform and tooling for a clinical records product. Mostly infrastructure, some developer experience work.",
  matchReason: "Remote, and platform work overlaps your stated interests.",
}

/** No `highlights`: the listing carried no bullet points worth copying. */
const CORVUS: Posting = {
  title: "Staff Engineer, Payments",
  company: "Corvus Bank",
  location: "Melbourne, VIC",
  url: "https://www.seek.com.au/job/dev-fixture-3",
  postedAt: "2026-07-30",
  summary:
    "Technical leadership across the payments group, splitting time between design review and hands-on work.",
  matchReason: "Senior scope, though the location is outside your list.",
}

/**
 * Derived rather than written out, so the letter and the Posting cannot drift —
 * the match is what draws the drafted state on the card.
 */
const DEV_DRAFTED_POSTING_ID = postingId(MERIDIAN)

/**
 * Fresh rows per call: the fake Prisma mutates what it is seeded with, so a
 * shared array would leak one seed's edits into the next.
 *
 * `nextRunAt` is computed rather than fixed — a hard-coded one is a next run in
 * the past, and computing it matches what `resumeJob()` writes on toggle.
 */
export function devJobs(): Job[] {
  return [
    {
      id: DEV_JOB_ACTIVE_ID,
      userId: DEV_USER_ID,
      name: "Sydney backend roles",
      config: {
        titles: ["backend engineer", "platform engineer"],
        locations: ["Sydney", "Remote"],
      },
      scheduleCron: DAILY_CRON,
      scheduleTimezone: "UTC",
      nextRunAt: computeNextRunAt(DAILY_CRON, "UTC", new Date()),
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
    {
      id: DEV_JOB_PAUSED_ID,
      userId: DEV_USER_ID,
      name: "Melbourne staff roles",
      config: { titles: ["staff engineer"], locations: ["Melbourne"] },
      scheduleCron: HAND_WRITTEN_CRON,
      scheduleTimezone: "Australia/Sydney",
      // Off duty. The only thing that makes `BriefingSummary.enabled` false.
      nextRunAt: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  ]
}

export function devRuns(): Run[] {
  return [
    {
      id: DEV_RUN_ACTIVE_ID,
      jobId: DEV_JOB_ACTIVE_ID,
      scheduledFor: RAN_AT,
      status: "succeeded",
      startedAt: RAN_AT,
      // A scheduled run is claimed by its slot, never by this column.
      claimedAt: null,
      finishedAt: new Date(RAN_AT.getTime() + 90_000),
      failure: null,
      findings: {
        postings: [MERIDIAN, NORTHWIND],
        notes: "One source timed out and was skipped.",
      },
    },
    {
      id: DEV_RUN_PAUSED_ID,
      jobId: DEV_JOB_PAUSED_ID,
      scheduledFor: RAN_AT,
      status: "succeeded",
      startedAt: RAN_AT,
      claimedAt: null,
      finishedAt: new Date(RAN_AT.getTime() + 45_000),
      failure: null,
      findings: { postings: [CORVUS] },
    },
  ]
}

/**
 * What the fake worker "finds" when a run is triggered from the UI.
 *
 * Deliberately a different set from what the seeded runs hold, so that a
 * triggered run visibly changes the page rather than appearing to do nothing.
 */
export function devAdHocFindings(): { postings: Posting[]; notes: string } {
  return {
    postings: [CORVUS, MERIDIAN],
    notes: "Found by a run you started from the dashboard.",
  }
}

/**
 * Documents as they arrive at `ResumeStore.put()`. Only `.md` and `.txt` can be
 * read back as text, so the Markdown CV is what makes drafting work end to end;
 * the PDF is here because its refusal has a UI.
 */
export function devResumes(): NewResume[] {
  return [
    {
      userId: DEV_USER_ID,
      resumeId: "3f8d1b2a-0000-4000-8000-0000000000c1",
      extension: ".md",
      bytes: encode(DEV_CV_MARKDOWN),
      originalFilename: "dev-user-cv.md",
      documentType: "resume",
    },
    {
      userId: DEV_USER_ID,
      resumeId: "3f8d1b2a-0000-4000-8000-0000000000c2",
      extension: ".pdf",
      // Not a real PDF; nothing renders its contents.
      bytes: encode("%PDF-1.4 dev fixture, not a real document"),
      originalFilename: "dev-user-cv.pdf",
      documentType: "resume",
    },
    {
      userId: DEV_USER_ID,
      resumeId: "3f8d1b2a-0000-4000-8000-0000000000c3",
      extension: ".txt",
      bytes: encode("Referees available on request.\n"),
      // No `documentType`: a real state in the bucket, renders without a badge.
      originalFilename: "referees.txt",
    },
  ]
}

export function devCoverLetters(): NewCoverLetter[] {
  return [
    {
      userId: DEV_USER_ID,
      postingId: DEV_DRAFTED_POSTING_ID,
      markdown: DEV_LETTER_MARKDOWN,
      draftedAt: new Date("2026-08-03T10:15:00.000Z"),
      provenance: {
        runId: DEV_RUN_ACTIVE_ID,
        title: MERIDIAN.title,
        company: MERIDIAN.company,
        url: MERIDIAN.url,
      },
    },
    {
      // The orphan: no current Run lists it, so it renders with no card.
      userId: DEV_USER_ID,
      postingId: "dev-fixture-superseded-posting",
      markdown:
        "# Draft\n\nA letter whose briefing run has since been replaced.\n",
      draftedAt: new Date("2026-07-28T08:00:00.000Z"),
      provenance: { title: "Integration Engineer", company: "Halcyon Rail" },
    },
  ]
}

/** The media type the real store would have derived from the extension. */
export function devContentType(kind: "resumes", extension: string): string {
  return contentTypeFor(kind, extension) ?? "application/octet-stream"
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

const DEV_CV_MARKDOWN = `# Dev User

Backend engineer, Sydney. Eight years across logistics and payments.

## Experience

**Senior Engineer, Kestrel Logistics** (2022–present)
Owned the dispatch service — TypeScript, Postgres, AWS. Took its p99 from
1.8s to 240ms by moving the hot path off a synchronous fan-out.

**Engineer, Tessellate** (2018–2022)
Built and ran the billing pipeline. Wrote the reconciliation job that closed
a long-standing class of silent under-charges.

## Skills

TypeScript, Go, Postgres, Terraform, AWS.
`

const DEV_LETTER_MARKDOWN = `# Senior Backend Engineer — Meridian Freight

Dear [Hiring Manager],

I am writing about the Senior Backend Engineer role. My last four years have
been spent on dispatch and tracking systems at Kestrel Logistics, which is
close to the container-tracking work you describe.

[Add a sentence here about why Meridian specifically.]

I would be glad to talk further, and am available from [start date].

Regards,
Dev User
`
