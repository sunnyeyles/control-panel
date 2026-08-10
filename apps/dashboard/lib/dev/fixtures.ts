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
import { contentTypeFor } from "@workspace/user-storage/kinds"
import type {
  NewCoverLetter,
  NewResume,
  NewTailoredResume,
} from "@workspace/user-storage"

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

/**
 * No `postedAt`: the advertisement did not say, which is the common case.
 *
 * On `au.linkedin.com` rather than `www.`, which is what the board actually
 * answers an Australian search with — and the case `boardForHost`'s suffix
 * match exists for, so the Source badge here reads LinkedIn and not a hostname.
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
 * ⚠️ **It carries no `matchReason`, and that is the point of it being here.**
 * There were no criteria behind a pasted link, so the field is absent — which
 * is legal only against `StoredPostingSchema` and not against the scout's own
 * `PostingSchema`. Under `DEV_AUTH_BYPASS` this is the row that proves a
 * link-added Posting parses, renders "Added by link" where the others name a
 * Briefing, and still opens a detail panel with no Match reason block.
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
  ]
}

/**
 * The rows the Postings table reads: every advertisement these briefings have
 * "ever" found, deduped, with a status on each.
 *
 * Fresh rows per call, for the reason {@link devJobs} gives — the fake Prisma
 * mutates what it is seeded with, so a shared array would leak one status
 * change into the next seed.
 *
 * Three properties this fixture exists to make checkable by hand, none of which
 * a smaller set would exercise:
 *
 * - **Thirty rows, so the table has two pages.** Pagination is a branch, and
 *   the file's philosophy is that fixtures are picked to exercise branches. At
 *   `PAGE_SIZE = 25` the second page holds five rows, which also proves the
 *   last page is not padded.
 * - **Every sort visibly differs.** Titles and companies run down the alphabet
 *   in the opposite order to the dates, `firstSeenAt` and `lastSeenAt` are
 *   spread over different spans, and the posting dates are scattered against
 *   both — so no two of "sorted by title", "sorted by last seen" and "sorted by
 *   posted" can be mistaken for each other on screen.
 * - **A third of the rows have no posting date**, which is what makes the
 *   Posted column's NULLS-LAST order checkable: they must sit at the bottom
 *   under *both* directions, not float to the top when it is reversed.
 * - **One row per status**, on the three hand-written Postings, so the status
 *   column is not thirty copies of `new`.
 * - **Both Briefings are represented, on both pages.** The Run a row names is
 *   what the detail dialog resolves into a Briefing name, so rows alternate
 *   between the two — see the loop below.
 *
 * ⚠️ **The ids are derived by `postingId()`, never written out.** The seeded
 * cover letter is keyed by {@link DEV_DRAFTED_POSTING_ID}, which is derived the
 * same way from the same Posting — hard-coding either would let the letter and
 * the row it belongs to drift apart, and the drafted state on the row is
 * exactly what that match draws.
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
    // No Run at all: the user added this one by pasting its link.
    {
      posting: HOLLOWAY,
      status: "new",
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
   * ⚠️ **Which Run a row names is no longer only bookkeeping.** The detail
   * dialog resolves it to the Briefing that found the advertisement —
   * `lastSeenRunId` → `runs.job_id` → `jobs.name` — so a fixture where every
   * generated row named {@link DEV_RUN_ACTIVE_ID}, as they all once did, would
   * put a single Briefing name on twenty-nine of the thirty rows and nothing
   * but that name on the second page. Alternating puts both on both pages,
   * which is what makes the point of the field — a table cumulative across
   * Briefings — checkable by eye.
   *
   * It stays a lie about which Run *found* them, and a harmless one: drafting
   * reads `postings.payload`, which every row here has, so **Draft cover
   * letter** works on a generated row and the run id only rides along as
   * provenance on the letter. It used to be refused as no longer in the run,
   * because the draft action re-read the Posting out of that Run's findings and
   * they hold two Postings.
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
 * ⚠️ **`postedOn` is passed in rather than parsed out of `posting.postedAt`,
 * deliberately.** A fixture is data, and the rule for reading a date out of
 * what a producer copied — `parsePostedAt()` in `@workspace/agents` — is
 * already stated twice, the other being the SQL backfill in
 * `0006_posting_posted_at`. Calling it here would put a rule in a fixture; the
 * caller supplies the answer instead, which is all a fixture ever needed to do.
 *
 * `runId` is `null` for a Posting the user added by pasting its link, which is
 * the state `0009` made legal.
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
 * ⚠️ **Both states are needed and neither is the default.** A page where every
 * row is scored never renders the em-dash the Match column shows for an
 * unscored advertisement, and never starts the scoring loop in
 * `score-pending-matches.tsx`; a page where none is never renders a number, a
 * reason or a gaps list. Two in three is what puts several of each on both
 * pages of the fixture set.
 *
 * ⚠️ **`matchResumeId` is the Markdown CV, which is the *newest* document
 * labelled Resume — so these rows read as scored against the current one.**
 * Naming the PDF instead would make every row stale, and every page view under
 * the flag would spend a real model call re-scoring thirty advertisements.
 *
 * All five together or none, which is what `postings_match_complete_check`
 * enforces in Postgres and what this returns as one object rather than five
 * fields for.
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
 * ⚠️ **The fourth entry is deliberately not a board.** Every fixture URL used to
 * be `www.seek.com.au`, so under `DEV_AUTH_BYPASS` the Source column would have
 * rendered one badge, forever, in the one environment this table is built in —
 * and the unrecognised-host path, which is the whole reason that badge has a
 * second variant, would never have been seen. Keep a host no entry in
 * `JOB_BOARDS` claims.
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
 * so no two sorts produce the same order. The host cycles independently of
 * both — no column sorts on it, so it is free to vary.
 *
 * `postedOn` is the caller's {@link generatedPostedOn} result, passed in
 * rather than recomputed here — the same value also becomes the row's
 * `postedAt` column in `devPostings`, so the two are one computation shared
 * through a parameter rather than two calls that merely happen to agree.
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
 * ⚠️ **Scattered rather than walked, on purpose.** Stepping seven days per row
 * and wrapping at thirty puts these in an order that matches neither the
 * alphabet the titles run down nor either sighting order, so a wrong `orderBy`
 * on the Posted column cannot hide behind a fixture that happened to be in that
 * order already.
 *
 * Midnight UTC, because that is what {@link generatedPosting} round-trips
 * through a `YYYY-MM-DD` string and what `parsePostedAt()` would read back out
 * of one.
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
 * Brightwater Systems — and a team of eleven.** That is the whole point of it:
 * it makes the acceptance criterion the split fields exist for checkable by
 * hand under the flag. Draft a letter and neither "Brightwater" nor the team
 * size may appear in it, because {@link DEV_CV_MARKDOWN} is the only source of
 * fact about this candidate. The instructions are checkable the same way by
 * eye: no letter may contain "passionate", and every one must end "Kind
 * regards".
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
 * {@link devResumes} is the bytes in the fake bucket; {@link devDocuments} is
 * the row in the fake database, and the row is what the application reads. The
 * `id` of a row is the `resumeId` of its object — that is the real key
 * relationship, not a convention of the fixtures — so a row without a matching
 * object lists fine and 404s on download, and an object without a row is
 * invisible. Both are real states in production; neither is a useful default
 * here, so the three below are paired.
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
export function devResumes(): NewResume[] {
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
 * `uploadedAt` is staggered rather than shared so the newest-first order is
 * observable: the Markdown CV is the newest, which is what makes it the one
 * **Draft cover letter** reads. The filename on the last one carries an en dash
 * on purpose — it is the character the old S3-metadata storage stripped, so a
 * row that shows it intact is the visible half of why this table exists.
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
 * ⚠️ **Exactly one, and it is on the Posting that already has a cover letter.**
 * That is what makes the two states checkable side by side without generating
 * anything: the Meridian row shows a tailored resume with its download, PDF,
 * replace and edit controls, and every other row on the page shows the
 * un-generated state. Seeding more would leave nothing to compare against.
 *
 * The markdown is deliberately {@link DEV_CV_MARKDOWN} rearranged rather than
 * rewritten — Kestrel first, the payments work cut, no employer or metric that
 * is not in the CV. It is the fixture *and* the worked example of the rule the
 * Resume Tailor's prompt is trying to hold.
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
 * employer, date, number and technology here appears in `DEV_CV_MARKDOWN`: the
 * logistics role leads, the billing role is shortened to one line, the skills
 * are reordered so the ones the advertisement names come first, and the payments
 * half of the summary is dropped because this advertisement is not about
 * payments. Nothing is added, nothing is upgraded, and there is no bracketed
 * placeholder anywhere — which is exactly the difference from
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
