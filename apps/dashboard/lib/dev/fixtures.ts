import type { CurrentUser } from "@/lib/auth/current-user"
import type { Posting } from "@workspace/agents/findings"
import { postingId } from "@workspace/agents/posting-id"
import type { StoredPosting } from "@workspace/agents/stored-posting"
/**
 * ⚠️ **Value imports use subpaths, not the barrels.** `current-user.ts` imports
 * `DEV_USER` from here and runs on every request, so the barrels would put
 * `@aws-sdk/client-s3` and `pg` on the production graph for a fixture. Types may
 * stay on the barrel — they are erased.
 */
import { computeNextRunAt } from "@workspace/db/schedule"
import type {
  CoverLetterInstructions,
  Document,
  Job,
  Posting as PostingRow,
  PostingStatus,
  Run,
} from "@workspace/db/types"
import { normalizeTitle } from "@workspace/job-search"
import { contentTypeFor } from "@workspace/user-storage/kinds"
import type {
  NewCoverLetter,
  NewResume,
  NewTailoredResume,
} from "@workspace/user-storage"

/**
 * The world `DEV_AUTH_BYPASS=1` renders.
 *
 * Picked to exercise branches, not to look plausible — a fixture where every
 * field is present proves nothing about the optional ones. Dates are fixed so
 * renders are deterministic, except `nextRunAt`; see {@link devJobs}.
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
 * The paused briefing's *latest* run, which found nothing.
 *
 * A third run rather than a change to the two above: it has to be the newest for
 * that briefing, and the earlier one has a Posting pointing at it
 * (`firstSeenRunId`). Together they are the state the `noPostings` warning
 * exists for — found a role last week, nothing today, same table underneath.
 */
const DEV_RUN_EMPTY_ID = "3f8d1b2a-0000-4000-8000-0000000000b3"

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

/**
 * No `postedAt`: the advertisement did not say, which is the common case.
 *
 * `au.linkedin.com` rather than `www.` is what the board answers an Australian
 * search with, and the case `boardForHost`'s suffix match exists for — so the
 * Source badge reads LinkedIn and not a hostname.
 */
const NORTHWIND: Posting = {
  title: "Platform Engineer",
  company: "Northwind Health",
  location: "Remote (Australia)",
  url: "https://au.linkedin.com/jobs/view/dev-fixture-2",
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
  url: "https://au.indeed.com/viewjob?jk=dev-fixture-3",
  postedAt: "2026-07-30",
  summary:
    "Technical leadership across the payments group, splitting time between design review and hands-on work.",
  matchReason: "Senior scope, though the location is outside your list.",
}

/**
 * A Posting nobody's Run found: the user pasted its link.
 *
 * ⚠️ **No `matchReason`, which is the point of it.** There were no criteria
 * behind a pasted link, so the field is absent — legal against
 * `StoredPostingSchema` and not against the scout's own `PostingSchema`.
 */
const HOLLOWAY: StoredPosting = {
  title: "Backend Engineer",
  company: "Holloway Labs",
  location: "Remote (Australia)",
  url: "https://boards.greenhouse.io/holloway/jobs/dev-fixture-linked",
  postedAt: "2026-08-04",
  summary:
    "Small platform team, mostly TypeScript and Postgres, four-day week.",
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
    {
      id: DEV_RUN_EMPTY_ID,
      jobId: DEV_JOB_PAUSED_ID,
      // A day later than the other two, so this is the run the briefing strip
      // reads — `latestRunPerJob` takes the newest per briefing.
      scheduledFor: new Date(RAN_AT.getTime() + 86_400_000),
      status: "succeeded",
      startedAt: new Date(RAN_AT.getTime() + 86_400_000),
      claimedAt: null,
      finishedAt: new Date(RAN_AT.getTime() + 86_400_000 + 60_000),
      // `succeeded` with a non-empty `failure`, which is what this column is for
      // — see `RunStatus` in `@workspace/db`. The worker writes exactly this
      // shape; `run-activity.ts` reads the message out of it.
      failure: {
        noPostings: {
          message:
            "Searched the boards 6 times, the second pass with the criteria widened, and nothing is currently listed for these criteria. Try a broader role title or another location.",
          reason: "no-matches",
          searched: 6,
          results: 0,
          excluded: 0,
          passes: 2,
        },
      },
      findings: { postings: [], notes: "Nothing open in Melbourne this week." },
    },
  ]
}

/**
 * The rows the Postings table reads: every advertisement these briefings have
 * "ever" found, deduped, with a status on each.
 *
 * Fresh rows per call, for the reason {@link devJobs} gives.
 *
 * What a smaller set would not exercise, all checkable by hand:
 *
 * - **Thirty rows**, so the table has two pages and the last is not padded.
 * - **Every sort visibly differs** — titles run up the alphabet as the dates run
 *   down, and the posting dates are scattered against both.
 * - **A third have no posting date**, so the Posted column's NULLS-LAST order is
 *   checkable: they must sit at the bottom under *both* directions.
 * - **One row per status**, on the four hand-written Postings — so changing one
 *   means finding the status it gave up.
 * - **Both Briefings on both pages**, via the alternating loop below.
 *
 * ⚠️ **The ids are derived by `postingId()`, never written out.** The seeded
 * cover letter is keyed by {@link DEV_DRAFTED_POSTING_ID}, derived the same way
 * from the same Posting; hard-coding either lets them drift, and the match is
 * what draws the drafted state on the row.
 */
export function devPostings(): PostingRow[] {
  const seeded = [
    // `postedAt` in the payload is "2 days ago", which is not a date — so the
    // column is NULL and the cell falls back to the advertisement's own words.
    {
      posting: MERIDIAN,
      status: "applied",
      runId: DEV_RUN_ACTIVE_ID,
      postedOn: null,
    },
    // The advertisement said nothing, so there is nothing in either place.
    {
      posting: NORTHWIND,
      status: "new",
      runId: DEV_RUN_ACTIVE_ID,
      postedOn: null,
    },
    // An ISO date the write path reads, so the column holds it and the cell
    // renders it formatted.
    {
      posting: CORVUS,
      status: "rejected",
      runId: DEV_RUN_PAUSED_ID,
      postedOn: new Date("2026-07-30T00:00:00.000Z"),
    },
    // No Run at all: the user added this one by pasting its link. Its status
    // is the fourth of four and carries no further meaning — a link-added
    // Posting is an ordinary one, and `new` is already on NORTHWIND.
    {
      posting: HOLLOWAY,
      status: "not-interested",
      runId: null,
      postedOn: new Date("2026-08-04T00:00:00.000Z"),
    },
  ] as const satisfies readonly {
    posting: StoredPosting
    status: PostingStatus
    runId: string | null
    postedOn: Date | null
  }[]

  const rows = seeded.map((row, index) =>
    devPosting(index, row.posting, row.status, row.runId, row.postedOn)
  )

  /**
   * The rest, generated, alternating between the two Runs.
   *
   * ⚠️ **Which Run a row names is not only bookkeeping.** The detail dialog
   * resolves it to a Briefing name — `lastSeenRunId` → `runs.job_id` →
   * `jobs.name` — so naming one Run throughout, as this once did, put a single
   * name on twenty-nine rows and nothing else on page two. Alternating is what
   * makes a table cumulative across Briefings checkable by eye.
   *
   * A harmless lie about which Run *found* them: drafting reads
   * `postings.payload`, which every row has, so the run id only rides along as
   * provenance.
   */
  for (let index = seeded.length; index < DEV_POSTING_COUNT; index++) {
    const postedOn = generatedPostedOn(index)

    rows.push(
      devPosting(
        index,
        generatedPosting(index, postedOn),
        "new",
        index % 2 === 0 ? DEV_RUN_ACTIVE_ID : DEV_RUN_PAUSED_ID,
        postedOn
      )
    )
  }

  return rows
}

/** Two pages at `PAGE_SIZE = 25`, with a short second one. */
const DEV_POSTING_COUNT = 30

/**
 * One row, with its sighting times derived from its position.
 *
 * `lastSeenAt` walks backwards in hours and `firstSeenAt` in days, so the two
 * date sorts do not agree with each other — a fixture where they did would make
 * a wrong `orderBy` invisible.
 *
 * ⚠️ **`postedOn` is passed in, not parsed out of `posting.postedAt`.** A
 * fixture is data; calling `parsePostedAt()` here would put a rule in one, and
 * that rule is already stated twice (there and in `0006_posting_posted_at`).
 *
 * `runId` is `null` for a Posting added by link — the state `0009` made legal.
 */
function devPosting(
  index: number,
  posting: StoredPosting,
  status: PostingStatus,
  runId: string | null,
  postedOn: Date | null
): PostingRow {
  const lastSeenAt = new Date(RAN_AT.getTime() - index * 3_600_000)
  const firstSeenAt = new Date(
    lastSeenAt.getTime() - ((index % 9) + 1) * 86_400_000
  )

  return {
    id: `3f8d1b2a-0000-4000-8000-${String(2000 + index).padStart(12, "0")}`,
    userId: DEV_USER_ID,
    postingId: postingId(posting),
    title: posting.title,
    // ⚠️ Derived, unlike `postedOn` above: `title_normalized` is
    // `GENERATED ALWAYS … STORED`, so a hand-written value is one the database
    // cannot produce. `normalizeTitle()` is the TypeScript half of that column.
    titleNormalized: normalizeTitle(posting.title),
    company: posting.company,
    location: posting.location,
    url: posting.url,
    postedAt: postedOn,
    payload: posting,
    status,
    // NULL for everything nobody has moved off `new`, which is the state the
    // worker writes and the only one it can write.
    statusChangedAt: status === "new" ? null : RAN_AT,
    firstSeenAt,
    lastSeenAt,
    // NULL in both for a Posting added by link: no Run has ever seen it.
    firstSeenRunId: runId,
    lastSeenRunId: runId,
    ...devMatch(index),
  }
}

/**
 * The match columns for one fixture row — a score for two rows in every three,
 * and nothing at all for the third.
 *
 * ⚠️ **Both states are needed and neither is the default.** All-scored never
 * renders the em-dash or starts the loop in `score-pending-matches.tsx`;
 * none-scored never renders a number, reason or gaps list.
 *
 * ⚠️ **`matchResumeId` is the Markdown CV — the *newest* document labelled
 * Resume — so these rows read as scored against the current one.** Naming the
 * PDF would make every row stale, and every page view under the flag would
 * spend a real model call re-scoring thirty advertisements.
 *
 * All five together or none: `postings_match_complete_check` enforces it, which
 * is why this returns one object rather than five fields.
 */
function devMatch(
  index: number
): Pick<
  PostingRow,
  "matchScore" | "matchReason" | "matchGaps" | "matchResumeId" | "matchedAt"
> {
  if (index % 3 === 0) {
    return {
      matchScore: null,
      matchReason: null,
      matchGaps: null,
      matchResumeId: null,
      matchedAt: null,
    }
  }

  // Spread across the bands the assessor's prompt names, so the column is not
  // thirty numbers in the seventies — and so sorting by it visibly reorders the
  // page rather than nearly preserving it.
  const score = 31 + ((index * 17) % 69)

  return {
    matchScore: score,
    matchReason:
      score >= 70
        ? "Your CV evidences the stack this role names and the seniority it asks for, with the domain the closest thing to a stretch."
        : "Adjacent rather than direct: the tools overlap, but the CV does not show the scale or the specialism this advertisement leads with.",
    // An empty list on some rows, because that is a real answer — the CV
    // evidenced everything stated — and the panel renders it by showing no
    // heading at all.
    matchGaps:
      score >= 70 ? [] : ["Kubernetes in production", "Team leadership"],
    matchResumeId: DEV_DOCUMENT_IDS.markdownCv,
    matchedAt: new Date(RAN_AT.getTime() - index * 60_000),
  }
}

/**
 * The hosts the filler rows cycle through, one per Source badge state.
 *
 * ⚠️ **The fourth entry is deliberately not a board.** With every URL on
 * `www.seek.com.au` the Source column rendered one badge forever, in the one
 * environment this table is built in, and the unrecognised-host variant was
 * never seen. Keep a host no entry in `JOB_BOARDS` claims.
 */
const GENERATED_HOSTS: readonly [string, ...string[]] = [
  "https://www.seek.com.au/job/dev-fixture-generated-",
  "https://au.linkedin.com/jobs/view/dev-fixture-generated-",
  "https://au.indeed.com/viewjob?jk=dev-fixture-generated-",
  "https://boards.greenhouse.io/acme/jobs/dev-fixture-generated-",
]

/**
 * A filler advertisement, distinct in every field a column sorts on.
 *
 * The title and company letters run *up* the alphabet as the dates run *down*,
 * so no two sorts produce the same order. The host cycles independently — no
 * column sorts on it.
 *
 * `postedOn` is passed in rather than recomputed: the same value becomes the
 * row's `postedAt` column, so it is one computation shared through a parameter
 * rather than two calls that merely happen to agree.
 */
function generatedPosting(index: number, postedOn: Date | null): Posting {
  const letter = String.fromCharCode(65 + (index % 26))
  const number = index + 1
  // A modulo index cannot be out of range; `noUncheckedIndexedAccess` types it
  // as optional anyway, so the fallback narrows rather than defends — and the
  // tuple type above is what makes the first element a definite `string`.
  const host =
    GENERATED_HOSTS[index % GENERATED_HOSTS.length] ?? GENERATED_HOSTS[0]

  return {
    title: `${letter}${number} Engineer`,
    company: `${letter}${number} Systems`,
    location: index % 3 === 0 ? "Remote (Australia)" : "Sydney, NSW",
    url: `${host}${number}`,
    // The date as the advertisement stated it, which is where a real payload
    // carries it.
    ...(postedOn === null
      ? {}
      : { postedAt: postedOn.toISOString().slice(0, 10) }),
    summary: `A generated fixture posting, number ${number} of ${DEV_POSTING_COUNT}.`,
    matchReason: "Generated so the table has enough rows to paginate.",
    highlights: [`Fixture row ${number}`],
  }
}

/**
 * When a generated advertisement says it was posted, or `null` for the third of
 * them that say nothing.
 *
 * ⚠️ **Scattered rather than walked, on purpose.** Stepping seven days and
 * wrapping at thirty matches neither the title alphabet nor either sighting
 * order, so a wrong `orderBy` on the Posted column cannot hide behind a fixture
 * that was already in that order.
 *
 * Midnight UTC, which is what {@link generatedPosting} round-trips through a
 * `YYYY-MM-DD` string.
 */
function generatedPostedOn(index: number): Date | null {
  if (index % 3 === 0) return null

  return new Date(POSTED_EPOCH.getTime() + ((index * 7) % 30) * 86_400_000)
}

/** The day the earliest generated posting date sits on. */
const POSTED_EPOCH = new Date("2026-06-01T00:00:00.000Z")

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
 * Both fields populated, because an empty row proves nothing the missing row
 * does not already prove.
 *
 * ⚠️ **The example letter claims an employer the CV does not mention —
 * Brightwater Systems — and a team of eleven.** That is the acceptance
 * criterion the split fields exist for, checkable by hand: a drafted letter may
 * contain neither, because {@link DEV_CV_MARKDOWN} is the only source of fact
 * about this candidate. The instructions check the same way — no "passionate",
 * always "Kind regards".
 */
export function devCoverLetterInstructions(): CoverLetterInstructions[] {
  return [
    {
      userId: DEV_USER_ID,
      instructions: DEV_INSTRUCTIONS,
      exampleLetter: DEV_EXAMPLE_LETTER,
      updatedAt: SEEDED_AT,
    },
  ]
}

/**
 * ⚠️ **A Document is two fixtures, and they have to agree.**
 *
 * {@link devUploads} is the bytes in the fake bucket, {@link devDocuments} the
 * row in the fake database, and a row's `id` is its object's `resumeId` — the
 * real key relationship, not a fixture convention. Each half alone is a real
 * production state (a row with no object 404s on download, an object with no
 * row is invisible), so the three below are paired.
 */
const DEV_DOCUMENT_IDS = {
  markdownCv: "3f8d1b2a-0000-4000-8000-0000000000c1",
  pdfCv: "3f8d1b2a-0000-4000-8000-0000000000c2",
  referees: "3f8d1b2a-0000-4000-8000-0000000000c3",
} as const

/**
 * Documents as they arrive at `ResumeStore.put()`. Only `.md` and `.txt` can be
 * read back as text, so the Markdown CV is what makes drafting work end to end;
 * the PDF is here because its refusal has a UI.
 */
export function devUploads(): NewResume[] {
  return [
    {
      userId: DEV_USER_ID,
      resumeId: DEV_DOCUMENT_IDS.markdownCv,
      extension: ".md",
      bytes: encode(DEV_CV_MARKDOWN),
      originalFilename: "dev-user-cv.md",
      documentType: "resume",
    },
    {
      userId: DEV_USER_ID,
      resumeId: DEV_DOCUMENT_IDS.pdfCv,
      extension: ".pdf",
      // Not a real PDF; nothing renders its contents.
      bytes: encode("%PDF-1.4 dev fixture, not a real document"),
      originalFilename: "dev-user-cv.pdf",
      documentType: "resume",
    },
    {
      userId: DEV_USER_ID,
      resumeId: DEV_DOCUMENT_IDS.referees,
      extension: ".txt",
      bytes: encode("Referees available on request.\n"),
      originalFilename: "referees.txt",
      documentType: "reference",
    },
  ]
}

/**
 * The rows in `documents` for the objects above — what `/documents`, the
 * settings picker and `loadCandidateBackground` actually read.
 *
 * `uploadedAt` is staggered so newest-first is observable: the Markdown CV is
 * the newest, which is what makes it the one **Draft cover letter** reads. The
 * en dash in the last filename is the character the old S3-metadata storage
 * stripped, so a row showing it intact is the visible half of why this table
 * exists.
 */
export function devDocuments(): Document[] {
  return [
    {
      id: DEV_DOCUMENT_IDS.markdownCv,
      userId: DEV_USER_ID,
      extension: ".md",
      filename: "dev-user-cv.md",
      docType: "resume",
      byteSize: encode(DEV_CV_MARKDOWN).byteLength,
      uploadedAt: SEEDED_AT,
    },
    {
      id: DEV_DOCUMENT_IDS.pdfCv,
      userId: DEV_USER_ID,
      extension: ".pdf",
      filename: "dev-user-cv.pdf",
      docType: "resume",
      byteSize: 40,
      uploadedAt: new Date(SEEDED_AT.getTime() - 86_400_000),
    },
    {
      id: DEV_DOCUMENT_IDS.referees,
      userId: DEV_USER_ID,
      extension: ".txt",
      filename: "referees – 2026.txt",
      docType: "reference",
      byteSize: 31,
      uploadedAt: new Date(SEEDED_AT.getTime() - 172_800_000),
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

/**
 * Tailored resumes as they arrive at `TailoredResumeStore.put()`.
 *
 * ⚠️ **Exactly one, on the Posting that already has a cover letter.** That puts
 * both states side by side without generating anything — Meridian shows the
 * download, PDF, replace and edit controls, every other row the un-generated
 * state. Seeding more would leave nothing to compare against.
 *
 * The markdown is {@link DEV_CV_MARKDOWN} rearranged rather than rewritten, so
 * it is the fixture *and* the worked example of the rule the Resume Tailor's
 * prompt is trying to hold.
 */
export function devTailoredResumes(): NewTailoredResume[] {
  return [
    {
      userId: DEV_USER_ID,
      postingId: DEV_DRAFTED_POSTING_ID,
      markdown: DEV_TAILORED_RESUME_MARKDOWN,
      generatedAt: new Date("2026-08-03T10:22:00.000Z"),
      provenance: {
        runId: DEV_RUN_ACTIVE_ID,
        title: MERIDIAN.title,
        company: MERIDIAN.company,
        url: MERIDIAN.url,
        sourceDocument: "dev-user-cv.md",
      },
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

/** One banned word and one exact sign-off — both visible at a glance in a draft. */
const DEV_INSTRUCTIONS = `Never use the word "passionate". Say what I actually did instead.
Keep it to three paragraphs or fewer, and no bullet points.
Sign off with "Kind regards", never "Sincerely" or "Yours faithfully".
`

/**
 * A style reference carrying facts that are not the candidate's: Brightwater
 * Systems employs nobody in {@link DEV_CV_MARKDOWN}, and no team of eleven
 * appears there either.
 */
const DEV_EXAMPLE_LETTER = `Dear Hiring Team,

When I joined Brightwater Systems their fulfilment platform was losing one
order in every two hundred. I led a team of eleven through the rebuild, and we
closed the year at one in forty thousand.

I write plainly, I would rather show a number than an adjective, and I would
like to do that work here.

Kind regards,
Dev User
`

/**
 * {@link DEV_CV_MARKDOWN}, rearranged for the Meridian advertisement.
 *
 * ⚠️ **Check it against the CV rather than reading it as filler.** Every
 * employer, date, number and technology here appears in `DEV_CV_MARKDOWN`,
 * reordered for this advertisement: nothing added, nothing upgraded, and no
 * bracketed placeholder — exactly the difference from
 * {@link DEV_LETTER_MARKDOWN} beneath it.
 */
const DEV_TAILORED_RESUME_MARKDOWN = `# Dev User

Backend engineer, Sydney. Eight years across logistics.

## Experience

**Senior Engineer, Kestrel Logistics** (2022–present)
Owned the dispatch service — TypeScript, Postgres, AWS. Took its p99 from
1.8s to 240ms by moving the hot path off a synchronous fan-out.

**Engineer, Tessellate** (2018–2022)
Built and ran the billing pipeline.

## Skills

TypeScript, Postgres, AWS, Terraform, Go.
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
