import type { CurrentUser } from "@/lib/auth/current-user"
import type { Posting } from "@workspace/agents/findings"
import { postingId } from "@workspace/agents/posting-id"
/**
 * ⚠️ **Subpaths, not the package barrels, and this file is why the rule exists.**
 *
 * `lib/auth/current-user.ts` imports `DEV_USER` from here, and that module runs
 * on every gated page and Server Action — so whatever this file reaches, the
 * production request path reaches too, even though `devMockEnabled()` is always
 * false there. `@workspace/user-storage`'s barrel re-exports
 * `createS3UserObjectStore`, which imports `@aws-sdk/client-s3`; `@workspace/db`'s
 * re-exports `createPrismaClient`, which imports `@prisma/adapter-pg` and `pg`.
 * Reaching them through the barrel would put both on the graph of a module that
 * had no business touching either, purely to read a fixture.
 *
 * Both packages say so themselves — "`@workspace/db/schedule` gets
 * `computeNextRunAt` without pulling in the driver at all" is in `db`'s own
 * index docstring. Type-only imports below stay on the barrel — those are
 * erased at compile time and reach nothing at runtime.
 */
import { computeNextRunAt } from "@workspace/db/schedule"
import type { Job, Run } from "@workspace/db/types"
import { contentTypeFor } from "@workspace/user-storage/kinds"
import type { NewCoverLetter, NewResume } from "@workspace/user-storage"

/**
 * The world `DEV_AUTH_BYPASS=1` renders — one user, two briefings, what they
 * found, and some documents.
 *
 * Chosen to exercise the branches a component actually has rather than to look
 * plausible in a screenshot. Each choice below is there because some `?:` in the
 * UI is otherwise never taken locally, and an unrendered branch is one nobody
 * notices they broke:
 *
 * - **Two briefings, one paused.** `nextRunAt: null` is the only thing that
 *   makes `BriefingSummary.enabled` false, so it is what draws the "Off" badge,
 *   the absent "Next run" line, and the switch in its other position.
 * - **One briefing with a cron the picker cannot express.** `0 3 1 1 *` is a
 *   real expression out of this database — `fromCron` returns undefined for it,
 *   which is what surfaces the "This schedule was set outside the app" warning
 *   in `components/settings/briefing-section.tsx`.
 * - **Postings missing their optional fields.** One has no `postedAt` and one no
 *   `highlights`, because `PostingView` treats both as optional and a fixture
 *   where every field is present never proves it.
 * - **A cover letter whose `postingId` matches a posting, and one that does
 *   not.** The first draws the drafted state on a Posting card; the orphan is
 *   the ordinary case of a letter whose Run has since been superseded, and it
 *   still has to render in the letters list on its own.
 *
 * Dates are fixed constants so a render is the same on Tuesday as on Friday —
 * with one exception, `nextRunAt`, which is computed from the cron at seed time
 * by the real `computeNextRunAt`. A hard-coded next run is a next run in the
 * past, which reads as a bug rather than as a fixture, and computing it here is
 * also what makes the value match what `resumeJob()` writes when the switch is
 * toggled.
 */

/** Fixed so every id derived from it — S3 keys included — is stable. */
export const DEV_USER_ID = "3f8d1b2a-0000-4000-8000-000000000001"

const SEEDED_AT = new Date("2026-08-01T00:00:00.000Z")
const RAN_AT = new Date("2026-08-03T09:00:00.000Z")

/**
 * The session every request gets under the flag.
 *
 * `status: "ok"` and nothing else: the `anonymous` and `refused` states have
 * their own pages, and a dev environment that could land on either would be
 * asking the developer to sign in — which is the thing this exists to avoid.
 *
 * `userId` is a `users.id`-shaped uuid, not a Neon Auth id, because that is the
 * distinction every consumer downstream depends on — it becomes the `userId`
 * segment of every S3 key the fake stores build, exactly as the real one does.
 */
export const DEV_USER: CurrentUser = {
  status: "ok",
  userId: DEV_USER_ID,
  email: "dev@localhost",
  name: "Dev User",
}

const DAILY_CRON = "0 0 * * *"

/** Deliberately unexpressible by the interval picker. See the note above. */
const HAND_WRITTEN_CRON = "0 3 1 1 *"

export const DEV_JOB_ACTIVE_ID = "3f8d1b2a-0000-4000-8000-0000000000a1"
export const DEV_JOB_PAUSED_ID = "3f8d1b2a-0000-4000-8000-0000000000a2"

const DEV_RUN_ACTIVE_ID = "3f8d1b2a-0000-4000-8000-0000000000b1"
const DEV_RUN_PAUSED_ID = "3f8d1b2a-0000-4000-8000-0000000000b2"

/**
 * Typed as `Posting` rather than left to inference, which does two things at
 * once: it checks these against the schema the scout actually emits, and it
 * keeps them assignable to `Prisma.JsonValue`. An `as const` here would make
 * every array `readonly`, and a readonly array is not JSON as far as Prisma's
 * types are concerned.
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
 * The Posting the seeded cover letter was drafted for.
 *
 * Derived with the real `postingId()` rather than written out, so the letter and
 * the Posting cannot drift apart — the match is what draws the drafted state on
 * the card, and a hand-copied id would silently stop matching the first time a
 * field above was edited.
 */
const DEV_DRAFTED_POSTING_ID = postingId(MERIDIAN)

/**
 * Fresh rows on every call.
 *
 * The fake Prisma mutates what it is seeded with — pausing a briefing writes
 * `nextRunAt: null` onto the row — so handing out a shared array would let one
 * dev server's edits leak into the next seed within the same process.
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
      finishedAt: new Date(RAN_AT.getTime() + 45_000),
      failure: null,
      findings: { postings: [CORVUS] },
    },
  ]
}

/**
 * Documents, as they would arrive at `ResumeStore.put()`.
 *
 * Only `.md` and `.txt` can be read back as text today, so the Markdown CV is
 * the one that makes "Draft a cover letter" work end to end; the PDF is here
 * because a user whose CV is a PDF is refused for a reason that has nothing to
 * do with their document being wrong, and that refusal has a UI.
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
      // Not a real PDF. Nothing in the dashboard parses it — `unpdf` is only
      // reached by the cover-letter path, which this fixture is not for.
      bytes: encode("%PDF-1.4 dev fixture, not a real document"),
      originalFilename: "dev-user-cv.pdf",
      documentType: "resume",
    },
    {
      userId: DEV_USER_ID,
      resumeId: "3f8d1b2a-0000-4000-8000-0000000000c3",
      extension: ".txt",
      bytes: encode("Referees available on request.\n"),
      // No `documentType`: written before document types existed, which is a
      // real state in the bucket and renders without a type badge.
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
      // The orphan: drafted for a Posting no current Run still lists. It has to
      // render in the letters list on its own, with no card to attach to.
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
