# Job-search briefing platform

The single-user platform this repo is growing toward: a scheduled agent searches
a job board on the user's behalf and writes up what it found, and the dashboard
surfaces it. Today the scaffold, the deployed worker, the S3 storage layer, and
one end-to-end briefing path exist. The dashboard manages **Documents** and
**Briefings**, and tracks every **Posting** those briefings have ever found —
one row per advertisement, accumulating across **Runs** and carrying the
**Posting Status** its owner set — but it surfaces no **Brief** yet, and cannot:
the markdown lives under an object-kind prefix the app holds no grant over.
`OVERVIEW.md` §Not built yet is the current list.

## Language

**Briefing**:
The recurring thing a user sets up: search on this cadence and file what you
find. One briefing is one row in `jobs` — the Schedules page creates, pauses,
resumes and reschedules jobs and calls every one of them a briefing. It is the
user-facing word for a **Job**, and the only one the interface uses.

Briefings divide by what they watch, and the interface groups them by that
rather than listing them all together. The job-search ones live under a section
called **Jobs** — `/jobs`, `/jobs/schedules` and `/jobs/letters`, three tabs of
one thing — which names a job search and still never names a **Posting**. A
second kind, watching a topic or the news, gets its own section beside it.

Each occurrence is a **briefing run**, and what that run produces is a **Brief**.
_Avoid_: calling the markdown a briefing — see **Brief**.

**Brief**:
The markdown one **Run** produces: a short document, one section per **Posting**,
written by the **Brief Writer** and uploaded through `@workspace/user-storage`'s
`BriefStore` to the `briefs` object kind. Landing in S3 is the success signal,
and the object key is what `artifacts` records. Built and running.
_Avoid_: digest, report (which means **Run Report**), briefing

**Scout**:
The agent that searches for postings and reports **Findings**. Carries one
search tool per **Job Board** — SEEK, Indeed and LinkedIn — and nothing else, so
it has no way to write anything: "a scraper returns data and performs no side
effects" is a property of its tool set, not a line in its prompt. Adding a board
means adding a tool to the scout's set and a name to
`JOB_SCOUT_SEARCH_TOOL_NAMES`, which is what the scout's
model-call budget is sized from.

Three tools, but still one scout: it searches every board in turn within a
single run and reports one merged list. Fanning out across several scouts and
merging their results is unbuilt, and is a different thing.
_Avoid_: scraper, crawler, search agent

**Brief Writer**:
The agent that renders **Findings** into the **Brief**'s markdown. Has no tools
at all, so it cannot look anything up and cannot supplement thin findings with
something it half-remembers. Not to be confused with the LangGraph runtime in
`agents-core`.
_Avoid_: synthesiser, orchestrator

**Posting Document**:
Something written for one **Posting** on the candidate's behalf, from that
Posting plus the candidate's own background text. There are two — the **Cover
Letter** and the **Tailored Resume** — and this is the name for what they are
both an instance of.

The word earns its place because the two agree on everything except what they
say. Both are addressed by `(User, Posting)` and by nothing else, so
re-generating overwrites one object rather than accumulating drafts. Both take
the never-expiring `resumes` retention posture, because the text is the user's
own voice and they may already have relied on it. Both get **no database row**,
because `artifacts.run_id` is `NOT NULL` and generating one is not an execution
of a briefing **Job**. Both are drawn from the stored Posting's `payload` and the
newest **Document** the user labelled a resume — so a letter and a resume for one
advertisement always describe the same candidate. Both carry provenance in object
metadata rather than in a column. Every one of those is a decision that was taken
once and then copied; naming the concept is what stops the third one from copying
it again.

**It is not an object kind, and there is no `posting-documents` prefix in the
bucket.** The kinds stay `cover-letters` and `tailored-resumes`, because they
hold different things and a reader listing the bucket should be able to tell
which is which. What the term names is the shape they share, which in the tree is
`apps/dashboard/lib/posting-documents/` and
`packages/user-storage/src/posting-document-store.ts`.

⚠️ **Not a Document.** A **Document** is something the _user_ uploaded and the
system reads; a Posting Document is something the system wrote and the user
edits. The two travel in opposite directions, and a Posting Document never
appears in the Documents list.

**What the two deliberately do not share is every sentence a user reads.** A
letter with no CV behind it and a resume with no CV behind it are the same
condition and the same reason code, and they are still told to the user
differently, because the next thing to do about it differs. Shared modules here
return a reason; the feature owns the wording.
_Avoid_: artifact (that is a row in `artifacts`), application document, generated
document, posting artefact

**Cover Letter**:
A **Posting Document** — a first-person draft for one **Posting**, written in the
candidate's voice by the **Letter Writer** from that Posting plus the candidate's
own background text. A draft the user edits, never a submittable letter: where a
fact was not supplied — a start date, a salary, a named recipient — it carries a
literal `[bracketed placeholder]`, because a plausible invention attributed to
the user is a lie.

Stored under its own object kind, `cover-letters`, at
`{environment}/{userId}/cover-letters/{postingId}.md`. **Keyed on the Posting,
not on the Run**, so re-drafting the same advertisement overwrites one object and
the previous draft survives as a non-current version — two Runs a week apart that
find the same advertisement agree on the id because `postingId()` derives it from
the URL. The never-expiring retention, the absent database row and the metadata
provenance are the **Posting Document** rules, and the reasoning for each is
there rather than repeated here. What rides in this kind's metadata is the Run,
the title, the company and the URL.

Drafted from the dashboard by a button on each **Posting** on `/jobs`. Its
source text is the stored Posting's `payload` — the validated advertisement as
the Run that found it reported, re-read server-side off the row rather than out
of that Run's **Findings**, and no part of what the button submitted; the
letter's provenance still names a Run, carried off the row's `last_seen_run_id`.
The `letter` CLI still writes one to disk from a Findings file. No **Document
Type** of the same name is involved — that label belongs to a letter the _user_
uploaded.
_Avoid_: application, letter of introduction

**Letter Writer**:
The agent that drafts a **Cover Letter**. Like the **Brief Writer** it has no
tools, and here that is containment rather than economy: it holds the
candidate's background in its context while a Posting's `highlights` — text
whoever paid for the advertisement wrote — reach its prompt verbatim. An agent
that could both read a CV and issue a request could be induced to put one inside
the other. When a page fetcher is eventually added it goes on a different agent
that never sees the profile.
_Avoid_: applicant agent, cover-letter bot

**Tailored Resume**:
A **Posting Document** — the candidate's own CV rewritten for one **Posting** by
the **Resume Tailor**, the relevant experience led with, the irrelevant cut, the
wording turned towards
the advertisement. **A rearrangement, never an addition**: every line must have a
counterpart in the source **Document**, so no employer, date, metric,
qualification or technology appears that was not already there. Unlike a **Cover
Letter** it carries no `[bracketed placeholder]` — a resume is read as a list of
facts, and a gap marker in one is a broken document rather than a visible
omission, so anything unknown is simply left out.

Stored under its own object kind, `tailored-resumes`, at
`{environment}/{userId}/tailored-resumes/{postingId}.md`. The Posting key, the
never-expiring retention and the absent database row are the **Posting Document**
rules; it follows them and adds nothing to them. Its metadata carries one field a
letter's does not: **which Document it was rewritten from**, because the selection
rule takes the newest one labelled Resume and that answer changes silently the
moment another is uploaded.

Generated from a button on each Posting on `/jobs`, beside the Cover Letter
controls, from the same `postings.payload` and the same `loadCandidateBackground`
— so a letter and a resume for one advertisement are always drawn from the same
CV. Downloaded as markdown, or as a **PDF rendered in the browser**: there is no
PDF on the server and no second stored object.

⚠️ **A fourth meaning of "resume" — read the **Document** entry below first.**
The kind `resumes` is the shelf uploads go on; the **Document Type** `resume` is
what a user calls one of those uploads; and this is neither. It is generated, it
is addressed by Posting, and it never appears in the Documents list.
_Avoid_: generated resume, CV variant, resume draft

**Resume Tailor**:
The agent that writes a **Tailored Resume**. Like the **Letter Writer** it has no
tools, and for the identical reason: it holds the candidate's whole CV in its
context while a Posting's `highlights` — text whoever paid for the advertisement
wrote — reach its prompt verbatim. Its prompt is fixed and takes no per-user
extension; there is no resume counterpart to **Letter Instructions**.

The prompt is the only place the no-invention rule exists — the output is
markdown and the source is markdown, so nothing downstream can tell a reordered
CV from an embellished one. What the dashboard side can do, and does, is refuse
to call the model when the source document would not support an honest answer.
_Avoid_: resume writer, CV generator, resume builder

**Letter Instructions**:
What the user tells the **Letter Writer** about how they want their letters
written — held per **User** in `cover_letter_instructions`, edited from
`/jobs/letters`, and applied to every **Cover Letter** they draft. Two fields, and
the split is a correctness decision rather than a tidy one: free-text
**instructions** ("never use the word 'passionate'", "sign off Kind regards"),
and an optional **example letter** the user pastes or pulls from a **Document**.

They _extend_ the writer's system prompt and never replace it. They may change
tone, length, structure, salutation, emphasis and vocabulary. They may not
license a claim the candidate's background text does not support, and may not
remove a `[bracketed placeholder]` — those clauses sit above the user's text and
win where the two conflict.

The example letter is a **style reference and never a source of facts**. A
sample letter is full of claims — "I led a team of eight" — and the writer's
governing property is that every claim about the candidate traces to their own
background text. Keeping the example in its own fenced section is what lets the
prompt say _imitate its voice, take no fact from it_; one undifferentiated field
structurally could not, and the model would lift claims out of the sample into a
letter sent in the user's name.

A failed read fails the draft. Drafting without them produces a letter that
looks perfect and quietly ignores every rule the user set, which is the same
silent-failure shape a run with no successful search refuses.
_Avoid_: prompt, custom prompt, system prompt (which is the writer's own, the
thing these extend), tone settings

**Findings**:
The scout's output and the writer's input: a validated list of **Postings** plus
optional notes, defined by `FindingsSchema` in `@workspace/agents`. The hand-off
travels as a `submit_findings` tool call, validated by the provider against
`ScoutFindingsSchema` and resolved into `Findings` by the worker — that
validation is the point of keeping the two agents apart, because data can be
checked and prose cannot. An empty findings list is a legitimate result; never
calling `submit_findings` at all is not, and fails the run.

Findings outlive the run that produced them: `runs.findings` is a nullable JSONB
column holding the validated record. It is written after the **Brief** exists
and never fatally — a run that produced a brief succeeds whatever happens to
this write, and a failure only adds a warning to the **Run**. NULL is an
ordinary state rather than a fault: either a run that failed before the
hand-off, or one that predates the column.

**Findings are not the postings table, and neither replaces the other.**
Findings are what one **Run** reported, kept against that Run and never revised.
The `postings` table is the record of the search across every Run: one row per
(**User**, **Posting**), accumulating, carrying the **Posting Status** its owner
set. The dashboard reads the table and not this column — an advertisement the
next Run does not re-find stays on the page, which a view assembled from the
newest findings structurally cannot manage — and the same Run writes both, one
after the other, each accessory and each losable with only a warning.

**Posting**:
One open job advertisement, with the URL a search actually returned. **Not** a
`jobs` row — see **Job** below, which is the collision worth being careful about.
The scout never handles that URL: a search result gives it an **id**, it reports
the id, and the worker resolves the id back to the URL the board issued through
the run's posting catalog. An id no search returned names nothing, so the posting
is dropped — which is what makes an invented posting impossible rather than
merely detectable. The id is `postingId()`, the same normalised identity used
below, so a board's per-search tracking parameters may differ and one
advertisement still has one id.

Also a stored row, in `postings`, keyed `(user_id, posting_id)` with **no Run in
it** — the same unit of identity a **Cover Letter**'s object key already uses,
and for the same reason: `postingId()` derives the id from the advertisement's
normalised URL, so two Runs a week apart that find it agree on one row rather
than minting two. Runs are provenance, recorded as `first_seen_run_id` and
`last_seen_run_id` instead of as part of the key. The row accumulates across
every Run of every **Briefing** the user owns, which is what lets a **Posting
Status** outlive the Run that found the advertisement.

**A Posting need not come from a Run at all.** Pasting an advertisement's link
on `/jobs` adds one directly — from the **Job Board**'s own actor where the board
is SEEK or Indeed, and otherwise read by the **Posting Extractor** off a page the
fetcher retrieved — and there is no Run behind it to name, so both run columns
are nullable and **NULL means the user added it by link**. That absence is the
whole of how the two are told apart: there is no `source` column and there must
not be one, for the reason `posting-source.ts` gives about the **Job Board** a
Posting came from. The two columns move independently, so a Run that later finds
a link-added advertisement sets `last_seen_run_id` and leaves `first_seen_run_id`
NULL — which reads, correctly, as "you found this one yourself". A link may
create a Posting and may never revise one: `recordLinkedPosting` is
`ON CONFLICT DO NOTHING`, so it cannot walk back a **Posting Status**, blank a
Run's provenance, or replace a Run-written payload with a thinner one.

The payload of a link-added Posting carries **no `matchReason`** — it was
matched against no criteria, and inventing one would be a fabrication — which is
why `StoredPostingSchema` exists beside `PostingSchema`. The first is what a
stored row may hold, the second is what a **Scout** must produce, and only the
first is optional in that field.

**A Posting also carries the experience its advertisement asked for, in the
advertisement's own words.** `experience` is free text — "5+ years", "at least 3
years in a similar role" — and never a number, exactly as `postedAt` is free
text and never a date: whoever produced the Posting copied a phrase or left the
field out, and is instructed never to read one off the seniority in the title.
Most advertisements state none, so absent is the ordinary answer. The one
producer with no model behind it is the **Job Board** path, where
`findExperienceStatement()` reads the phrase off what the board published — and
that rule is applied there and nowhere else, because a pattern running on top of
a model that was shown the advertisement would be a second rule producing the
same field.
_Avoid_: job, listing, vacancy, opening

**Match**:
How well one **Posting** fits the person reading it, as a score from 0 to 100
with the reason behind it and the requirements it does not answer. Held in five
columns on `postings` — `match_score`, `match_reason`, `match_gaps`,
`match_resume_id`, `matched_at` — all NULL together or all set together, which a
CHECK enforces.

**Distinct from a Posting's `matchReason`, and neither replaces the other.**
`matchReason` is one sentence a **Scout** wrote about the **Search Criteria** it
was handed; criteria are a lossy projection of a person, so "why this fits your
search" is not an answer to "should I apply". A Match is the judgement against
the **Document** the user labelled Resume, which is. A Posting added by link has
a Match and no `matchReason` at all.

**Only the dashboard writes one**, and the reason is a boundary rather than a
preference: the briefing worker's IAM role grants the `briefs` shelf and nothing
else, so the one process that finds an advertisement structurally cannot read
the CV it would be scored against. The consequence is stated plainly in the UI —
a **Briefing** that runs overnight leaves its Postings unscored until somebody
opens `/jobs`, where a bounded loop works through the backlog.

The five columns join **Posting Status** in the list `recordPostings` leaves out
of its `DO UPDATE SET`, and for the same reason: a Run re-finding a scored
advertisement must not blank the score.

`match_resume_id` names the `documents.id` the score was computed against, and
is the whole of how a score goes stale — a value other than the user's current
resume means the Match describes a document they have replaced, and the row is
scored again.
_Avoid_: fit, rating, relevance, rank

**Match Assessor**:
The agent that produces a **Match**. Tool-less, like the **Letter Writer** and
the **Resume Tailor**, and for the identical reason: it holds the candidate's CV
and an advertisement side by side, the advertisement is written by whoever paid
to place it, and copied bullet points reach the prompt verbatim. An agent that
can both read a CV and issue an outbound request can be induced to put one
inside the other. Having no tools is what makes quoting the advertisement
acceptable — injected text can move a number the user then reads beside the
advertisement that moved it, and can reach nothing else.

It credits only what the resume names and penalises only what the advertisement
states, so a thin advertisement is an easy match rather than a bad one, and a
gap is always a requirement that was actually asked for.
_Avoid_: scorer, matcher, ranker

**Posting Status**:
Where the user has got to with one **Posting**: `new`, `applied`,
`not-interested` or `rejected`, held in `postings.status` behind a CHECK that
admits nothing else. **`new` is the only one discovery writes** — it is the
column's default, and `status` is the one column in this schema a _person_
writes.

**Who acts is not the same across the four, and the words only read correctly
if you know that.** `applied` and `not-interested` are decisions the user takes
about the advertisement — one to pursue it, one to pass on it. `rejected` is
the **employer's** answer to an application already sent, so it can only
sensibly follow `applied`. Nothing enforces that ordering and nothing should: a
person may revise any of these in any direction, including back to `new`, and
the CHECK says which words exist rather than which move to which.

`not-interested` is the one that stops a decision being lost. Without it,
passing on an advertisement leaves the row at `new` — indistinguishable from
one nobody has opened — and deleting it does not settle the question either,
because the next Run to re-find the advertisement inserts it again at `new`.

Spelled with a hyphen, not `not_interested`: that is how this schema already
spells a multi-word CHECK value, as `documents.doc_type` does with
`cover-letter`.

**A Run must never overwrite the other two**, and that is the whole feature. It
lives in one place: the `DO UPDATE SET` list of `recordPostings`, which omits
`status` and `status_changed_at` — as it omits the `first_seen_*` pair, for the
neighbouring reason that a second sighting cannot change when something first
appeared. Adding `status` back "for symmetry", or rewriting the upsert as a
DELETE and an INSERT, reverts every Posting marked `applied` the next time a Run
re-finds the advertisement: on a schedule, with no error and no trace.

`status_changed_at` is NULL until somebody moves a row off `new`, so it answers
"when did the user last touch this" and never "when was this last seen" — that
question is `last_seen_at`, which a Run does write.
_Avoid_: state, stage, application status, pipeline

**Job Board**:
Where a **Posting** was advertised. Three today — SEEK, Indeed and LinkedIn —
each reached by its own **Scout** tool over its own Apify actor, and each
reaching one board's inventory and no other.

**A Posting's board is derived from its URL, and is stored nowhere.**
`postings` has no source column and does not want one: `postingId()` already
derives a Posting's whole identity from its normalised URL, so the board is a
function of a fact the row already carries. A column would be a second copy that
can drift — a Run rewrites `url` on every sighting — and it would answer only
for rows written after it existed, where deriving answers for every row ever
recorded. `boardForHost()` is the one rule that turns a host into a board;
`apps/dashboard/lib/postings/posting-source.ts` is the only thing that renders
the answer, as the Source badge on `/jobs`, and a host no board claims
shows as the bare hostname rather than as nothing.

`JOB_BOARDS` in `packages/agents/src/job-boards.ts` is **not** a registry of
tools and selects nothing: a board is listed there when its URLs need
normalising, and its `trackingParameters` are the stamps that would otherwise
give one advertisement two ids across two Runs.

Not to be confused with **Search Criteria**'s `sources`, which is a list of
boards the candidate follows, is context for ranking, and is explicitly not a
filter — the scout searches every board it has a tool for whatever that says.
_Avoid_: site, source (which means the `sources` criterion), search provider

**Search Criteria**:
What a candidate is looking for — titles, locations, keywords, exclusions,
preferred boards, a cap on how many postings a brief carries. Held in
`jobs.config` and interpreted by `packages/job-search/src/job-search-config.ts`.
The platform stores that column and never reads inside it, so the meaning lives
with whatever runs the job.

Titles and locations are required, and with **keywords** — optional to the
worker, collected anyway — they are what the new-briefing form takes; `exclude`,
preferred boards and the cap reach a row only by hand. `exclude` is a hint the
scout may weigh and is **not** the **Title Filter** below, which is enforced and
belongs to the user rather than to the job. Naming no keywords leaves
the field _absent_ from `config` rather than present and empty, so "never said"
stays distinguishable from "said none".

**A briefing searches for at most three titles, and the number is arithmetic
rather than taste.** A run fans out to `titles × locations × boards` searches
against the **Scout**'s hard model budget, and a config wider than that budget
does not fail — the scout is routed to `halt` mid-sweep and answers with a
well-formed **Brief** drawn from part of the search, which is indistinguishable
from a quiet market. The cap belongs to the form (`MAX_ROLE_TITLES`), not to
`JobSearchConfigSchema`: a row written before it existed keeps running exactly
as it did, and simply cannot be re-saved from the form until it is trimmed. The
form states the search count as it is typed and refuses a combination that would
be cut short, because the failure it is preventing is invisible afterwards.

Both are **editable after creation** — `updateJobConfig` replaces the whole
`config`, leaving the name and the cadence alone. Until that existed the
criteria were write-once and changing a title meant deleting the briefing.

**Say "role title", never "job title".** The word `job` is the schema's and
means a row in `jobs`; a **Posting**'s title is a role title everywhere in this
system, including in the UI copy and in identifiers.

The **Profile Extractor** proposes all three, and proposes them **into the
form**. It writes nothing: a suggestion is a value the fields render, and the row
is still written by the user pressing Create. That is what makes "the user saw
these before they were saved" a property of the path rather than a promise the
interface makes — there is no write on it to review after.

Every criterion here is inclusive — each one widens a search. The subtractive one
is the **Title Filter**, and it is not part of this: it belongs to the **User**
rather than to a **Job**.

**Title Filter**:
Words that rule a **Posting** out by its title. One list per **User**, in
`posting_filters.title_exclusions`, edited on `/jobs/schedules` and applying to
every **Briefing** that user has.

**Enforced, not requested, and that is the whole difference from `exclude`.**
`jobs.config -> 'exclude'` is a **Search Criterion**: it is rendered into the
scout's brief and the model may weigh it. This is applied twice as a rule the
model has no part in — the worker drops a matching posting after the hand-off and
before the **Brief Writer** sees it, so nothing new arrives; and the Postings
table leaves out a matching row it already holds, so nothing old lingers. The
scout is told about it as well, which buys fewer wasted searches and no
correctness at all.

Matching is **whole-word and case-insensitive, against the title only**:
`senior` rules out "Senior Backend Engineer" and never "Seniority Partners". The
rule is `normalizeTitle()` in `@workspace/job-search` and, restated in SQL, the
`postings.title_normalized` generated column — both sides lowercase the text,
flatten punctuation to single spaces and pad the result, which is what turns
whole-word matching into a substring test a paginated query can answer.

**Hiding is never silent**, which is the property the feature would otherwise
break: the Postings table says how many rows the filter removed, the **Run
Report** carries `excludedPostings`, and pasting a link for a posting the filter
would hide is refused rather than added invisibly. Nothing is deleted — clearing
the list brings every row back with the **Posting Status** it had.
_Avoid_: blocklist, blacklist, mute

**Posting Extractor**:
The agent that reads one retrieved web page and reports the **Posting** in it,
for a link the user pasted. Has no tools, and here that is the strongest
containment case in the repo after the **Profile Extractor**'s — it reads a page
fetched from a host the user merely named, which is the least trusted input
anywhere in the system, and it reads it verbatim because summarising a page
before extracting from it would be doing the extraction twice.

**It is never shown the URL and cannot return one.** The platform already holds
the link; a page is full of others — an apply button, a related role, the
company's own site — and one copied into the row would be stored as though it
were the advertisement. That is the **Scout**'s rule (see `resolve-postings.ts`)
applied to a second path, and here it is structural twice over: the prompt
carries no URL, and the answer schema has no field for one.

Its answer is a union rather than a shape, so a refusal is data: a
search-results page, a careers index, an article or a sign-in wall come back as
`not-a-posting` with a reason the user is shown. Returning a Posting assembled
out of a page that contains none is the failure that branch exists to prevent.

The page reaches it through `extractPage` in `@workspace/agent-tools`, which is
**deliberately not a tool** — a plain function, absent from `allTools`, carried
by no agent. Retrieval is delegated to Tavily, so nothing in this system opens a
socket to a host somebody typed into a form.

**It is not reached at all for a link a Job Board can answer.** SEEK's and
Indeed's actors take a single advertisement's URL and return its fields, so
`board-fetch.ts` builds the Posting from what the board published and no model
runs. This agent is the path for everything else — including LinkedIn, whose
actor accepts search-results URLs only.
_Avoid_: scraper, page reader, link parser

**Profile Extractor**:
The agent that reads the candidate's CV and proposes **Search Criteria** out of
it — titles and keywords from what the document actually claims, and a location
only where the CV states one. Where it does not, `locations` comes back empty and
`notes` says why: a city inferred from a university or an employer's head office
is an invented fact about where someone will work, and unlike a bad sentence in a
draft it is saved once and then searched every day, arriving as thin briefs that
look like a quiet market.

Its answer is validated by `SearchCriteriaSchema` before anything renders it,
standing between the extractor and the form exactly as **Findings** stand between
the **Scout** and the **Brief Writer**. Reading a CV is the one step in the
pipeline with nothing to check against — no URL to click, no advertisement to
re-fetch — so the shape of the answer is the only thing that can be verified, and
a parse that fails refuses rather than degrades.

Like the **Brief Writer** and the **Letter Writer** it has no tools, and this is
the strongest case for that in the repo: it holds one uploaded document verbatim,
including whatever address, phone number and employment history it carries, and
the uploaded file is itself the injection surface — nothing sanitises it, and a
closed **Allowlist** does not help, since a user can be handed a document as
easily as they can write one. Having nowhere to send it is what makes reading it
verbatim acceptable; injected text can shape a JSON object the user then reviews,
and can reach nothing else.

Run from **Suggest from my resume** on the new-briefing form on `/jobs/schedules`, over
the newest **Document** labelled Resume — the same `loadCandidateBackground` a
**Cover Letter** draft reads, so no field of the request picks the document. It
persists nothing; see **Search Criteria**.
_Avoid_: resume parser (which is the text extraction that happens before this
agent is built), CV reader, profile agent

**Role Title Suggester**:
The agent that proposes the role titles _adjacent_ to the ones a candidate has
already chosen — a lateral move into a neighbouring specialism, the same work
under a different name, the title a **Job Board** uses where the candidate used
an internal one. Run from **Suggest related titles** on the new-briefing form and
on a briefing's criteria editor, over the same CV `loadCandidateBackground`
gives every other agent that reads one.

**Distinct from the Profile Extractor, and neither replaces the other.** The
extractor answers "what should this person search for" from a blank start and
proposes whole **Search Criteria**; this answers "what else, given these", and
its entire value is in the titles the first list does not contain. Its schema
has one field where the extractor's has three, deliberately — a shared shape
would let a set of adjacent titles be handed to something expecting complete
criteria, with the locations it never proposed silently empty.

Tool-less, for the **Profile Extractor**'s reason: it holds one uploaded
document verbatim, and the upload is itself the injection surface. It has a
second untrusted input the extractor does not — the titles the user typed — and
they are fenced separately from the CV, because folding them into the document's
fence makes them read as text _about_ the candidate rather than as the set the
answer must avoid, and the agent proposes them straight back.

Its answers are **snapped to the checked-in completion list** where a normalised
match exists (`canonicalRoleTitle`), so that one role proposed by two agents
under two spellings does not become two buttons and two searches out of a budget
of three. An empty list is a legitimate answer, and the form says so in words
rather than rendering no buttons.
_Avoid_: title generator, role recommender, job-title agent (see **Search
Criteria** on why "job title" is never the phrase)

**Job**:
A thing to run on a cadence, and a row in `jobs` — the Prisma model is `Job`.
**Never an employment opportunity** — that is a **Posting**. The word is
load-bearing in the schema (`jobs`, `job_id`, `dueJobs`, `claimJob`) and predates
the job-search product, so the schema keeps it and prose must not borrow it back.
The interface never says it: to a user this is a **Briefing**.

Owns its own cron expression and IANA timezone — Postgres is the source of truth
for cadence, not Terraform, so adding a job with a new cadence costs an INSERT
rather than an apply. A job with no `next_run_at` is not scheduled; that one
absence covers both paused and retired.

**Tick**:
The hourly invocation of the worker that asks the database which jobs are due and
runs them. What lives in Terraform is the tick, not any job's schedule — the tick
is the same for every job, so there is nothing left in it to drift. Hourly is
therefore the resolution of the whole system: a job's cron can name any hour,
and nothing finer than an hour is observable. A tick that finds nothing due is a
success.
_Avoid_: poll, sweep, cron run

**Run**:
One execution of a job, and a row in `runs`. Carries its status
(`running` → `succeeded` | `failed`, both terminal), the slot it occupied, and
its timings. This is the queryable state: what a dashboard would list and what a
filter runs against.

Distinct from the **Run Report** below, which is the log line. The two complement
each other and neither replaces the other — the row is queryable, the report
keeps the diagnostics nothing will ever query, and the report is the only record
left when a run dies before it can write a row.

A run with no `scheduled_for` is ad-hoc: it occupies no slot, and any number of
them may exist for one job. The **Run now** button on `/jobs` starts one —
the dashboard inserts the row and asks the worker to pick it up, and because the
run fills no occurrence it neither consumes the next scheduled run nor moves it
closer, and it works on a **Briefing** that is turned off. `runs.claimed_at` is
what makes it at-most-once, standing in for the slot the scheduled path claims:
the trigger is an asynchronous Lambda invocation, which AWS delivers _at least_
once.
_Avoid_: execution, attempt, task run

**Artifact**:
A row in `artifacts`, and the claim that a **Run** produced something durable. It
holds an S3 object key and nothing else of the content — `object_key` is UNIQUE
and a CHECK rejects URL schemes and leading slashes, so Postgres cannot be talked
into holding a URL or a blob. Written only after the upload returns, because the
reverse order can leave a row pointing at nothing.

`artifacts.run_id` is `NOT NULL` and references `runs`, so there is no row shape
for something a person uploaded. A **Document** is therefore recorded nowhere but
S3.
_Avoid_: file, output, attachment

**Account**:
The identity someone signs in with, held by Neon Auth in the `neon_auth` schema
of this same database. Neon owns its shape; we never write to it. An account
exists as soon as someone completes an OAuth flow — having one says nothing about
whether they are allowed in.
_Avoid_: login, profile, credentials

**User**:
The platform identity, and a row in `users`. What `jobs.user_id` references and
what becomes the `userId` segment of every S3 object key, which is why it stays a
uuid this repo generates. Deliberately carries no name or email — those live on
the **Account**, and `users.auth_user_id` is the one link between the two.

The two are not one thing wearing two hats: a user may exist with no account, and
an account may exist with no user (someone signed in but is not on the allowlist,
so nothing was ever minted for them).

**Document**:
Something the user uploaded themselves — a CV, a cover letter, whatever they want
kept beside their job search. The dashboard section is called **Documents**, and
it is the user-facing word for the whole shelf.

**A Document is two things, written in that order**: an object in the bucket
holding the bytes, and a row in `documents` holding everything about it — the
filename, the **Document Type**, the size, when it landed. The row's `id` _is_
the object's key segment, which is why the id is minted by the application
rather than by the database: the object has to be written first, so that a
failure leaves an object nothing points at rather than a row pointing at
nothing. The row is what every read path uses; the bucket is consulted only for
bytes.

⚠️ **Four different meanings of "resume" collide here, and two of them are key
segments.** The storage _kind_ is `resumes`, so an object key reads
`prod/{userId}/resumes/{id}.pdf` no matter what the document actually is; a cover
letter is stored under `resumes` too. Meanwhile **Resume** is also one of the six
selectable **Document Types**. The kind is not renamed because a kind is a key
segment, an object tag and a file-type allowlist at once — the tag is what the S3
lifecycle rules filter on, so renaming it would orphan every existing object's
retention. Read `resumes` as "the shelf uploads go on", not as "these are all
CVs".

The fourth is the **Tailored Resume**, and it is deliberately _not_ on this
shelf. It is generated rather than uploaded, addressed by **Posting** rather than
by an id this app minted for a file it did not produce, and it wants one file
type where `resumes` accepts seven — so it has a kind of its own,
`tailored-resumes`, and never appears in the Documents list. The one thing the
two share is that a Tailored Resume is always _rewritten from_ a Document on this
shelf, and records which one.
_Avoid_: file, attachment, upload (as a noun)

**Document Type**:
What the user says a **Document** is: `resume`, `cover-letter`, `portfolio`,
`reference`, `certification` or `other`. A `doc_type` column on `documents`, text
plus a CHECK rather than a Postgres enum, exactly as `runs.status` and
`postings.status` are. Emphatically **not** a storage kind of its own — a
separate kind buys only separate retention and separate accepted file types, and
these six want neither: one shelf, one retention policy, seven file types,
labelled.

`NOT NULL`, defaulting to `other`. There is no "unlabelled" state: an upload
whose posted label is not one of the six lands on `other`, which exists for
exactly that and reads as an answer rather than a gap.

It used to be S3 object metadata, which meant it was fixed at write time —
metadata cannot be changed without copying the object onto itself, which
`UserObjectStore` deliberately does not expose, so relabelling meant uploading
the document again. A column can be updated, so that constraint is gone; a
relabel control is simply not built yet. The old `document-type` metadata is
still stamped on each object as provenance and is read by nothing.
_Avoid_: category, kind (which means the storage kind), tag (which means the S3
tag that drives retention)

**Allowlist**:
The set of email addresses permitted past the gate, read from
`AUTH_ALLOWED_EMAILS`. Signup is closed and this is what closes it — Neon Auth
will happily create an account for anyone who completes an OAuth flow, so being
refused happens on our side, on every request. An unset list refuses everyone.
_Avoid_: whitelist, approved users, invite list

**Gate**:
The two layers that together refuse an anonymous request: `proxy.ts`, which
matches everything but static assets and so is closed by default, and the
authoritative check inside the route or page. Neither is sufficient alone, and
that is the point — the proxy is a routing concern, and the route is what must
not be reachable by accident.

On a **non-GET** request the first layer is weaker than it looks: the auth SDK
cannot evaluate a POST session, so the proxy falls back to checking that a session
cookie is merely present. Every Server Action arrives that way, which makes the
check inside the action the only real one.

**Run Report**:
The single structured log line a briefing run emits describing its outcome —
`event: "briefing-run"`, carrying the search count, the model calls, and the
object key. The artifact a human queries to verify a run happened. A **Tick
Report** (`event: "tick"`) is its per-tick counterpart, answering "was there
anything to do" rather than "what happened in this run".
_Avoid_: run record, run log, result row

**Trace**:
The transcript of one **Run**: every step boundary, prompt, model message and tool
round trip. The third thing beside the **Run** and the **Run Report**, and neither
replaces it — the row is queryable state, the report is the outcome, and the trace
is what the run actually did on the way there. It answers "why did it do that",
which the other two structurally cannot: a report saying `"searches":2` cannot say
what was searched for.

Two independent mechanisms produce one, and they do not feed each other:

- **The trace sink** (`apps/briefing-worker/src/trace.ts`) is a stream of typed
  events `runBriefing` emits into an optional sink. Production passes none, and a
  run with no sink emits nothing and behaves identically; the local `watch`
  harness passes one and renders it.
- **Langfuse** receives a trace per agent invocation over OpenTelemetry —
  `generate-briefing` from the worker, and `chat-response`, `cover-letter`,
  `posting-extract`, `search-criteria`, `tailored-resume` and `whiteboard-turn`
  from the dashboard — through `@workspace/langfuse`. Only the first is a **Run**; the dashboard
  traces are things a person clicked, and no `runs` row is minted for any of
  them, so the trace is the only place their prompt survives. Missing keys make
  it a no-op rather than an error, so this too is a thing a runtime opts into.

_Avoid_: log, debug output, history

**Whiteboard**:
The shared infinite canvas at `/whiteboard`, one per **Account**, that the user
and an agent draw on at the same time. The only feature in the product with no
connection to the job search, and the only agent that writes to something the
user is simultaneously editing.

**"Board" alone is ambiguous in this repository and should not be used** — a
**Job Board** is SEEK, Indeed or LinkedIn, and the two senses sit two hundred
lines apart in this file. Say "whiteboard" for the canvas and "job board" for
the other, always, including in a **Pull Request** body.

Three nouns hang off it, and they are not interchangeable:

- **Snapshot**: the whole tldraw store, serialised, in `boards.snapshot` — one
  JSONB row per user, replaced wholesale on autosave. Opaque to the server,
  which never reads inside it.
- **Board Context**: what the browser sends _up_ with a turn
  (`boardContextSchema`) — the shapes, the arrows, what is selected, what the
  user just drew, and what is off screen. A summary built for a model, roughly a
  tenth the size of the snapshot, and re-sent every turn rather than accumulated.
- **Canvas Op**: one mutation travelling back _down_ — create, update, move,
  delete, connect, focus. Ops ride a separate stream from the assistant's prose,
  which is why shapes appear while the sentence describing them is still being
  typed, and a turn's ops share a `turnId` so one undo takes the whole turn back.

The **Shadow Board** is the server's copy of the canvas for the duration of one
turn (`board-session.ts`), and lives only so the fourth tool call can name the
shape the first one created. The browser remains the source of truth; drift is
bounded to a turn and repaired by the next one's Board Context.

_Avoid_: board (on its own), canvas state, drawing, diagram (a **Whiteboard**
holds diagrams; it is not one)

**Eval**:
One scored run of an agent against a fixed input, and the suite of them under
`packages/agents/evals/`. A **Case** is the input — a **Board Context** and a
sentence — plus what a good answer would have to be true of; a **Grader** turns
one run into a score between 0 and 1; an **Experiment Run** is one pass over
every selected case, recorded in Langfuse, and the thing the next pass is
compared against.

There is no baseline artefact in the repository, and "the baseline" is not a
file: it is whichever earlier **Experiment Run** you are reading the delta
against.

Not a test. A test asserts and fails; an eval scores, varies between runs, and
is read as a delta. `pnpm test` never runs one, and a low score is deliberately
not a build failure — see `packages/agents/evals/README.md`.
_Avoid_: benchmark, test (for the run), accuracy, ground truth, baseline file
