# Control panel

A single-user dashboard: a chat **Assistant**, a shelf of **Documents** the user
uploaded, and a **Whiteboard** the user and an agent draw on at the same time.
This is the glossary for it. `OVERVIEW.md` says where each part lives.

## Language

**Account**:
The identity someone signs in with, held by Neon Auth in the `neon_auth` schema
of this same database. Neon owns its shape; we never write to it. An account
exists as soon as someone completes an OAuth flow — having one says nothing about
whether they are allowed in.
_Avoid_: login, profile, credentials

**User**:
The platform identity, and a row in `users`. What `documents.user_id` and
`boards.user_id` reference and what becomes the `userId` segment of every S3
object key, which is why it stays a uuid this repo generates. Deliberately
carries no name or email — those live on the **Account**, and
`users.auth_user_id` is the one link between the two.

The two are not one thing wearing two hats: a user may exist with no account, and
an account may exist with no user (someone signed in but is not on the allowlist,
so nothing was ever minted for them).

**Document**:
Something the user uploaded themselves — a CV, a cover letter, a portfolio,
whatever they want kept. The dashboard section is called **Documents**, and it is
the user-facing word for the whole shelf.

**A Document is two things, written in that order**: an object in the bucket
holding the bytes, and a row in `documents` holding everything about it — the
filename, the **Document Type**, the size, when it landed. The row's `id` _is_
the object's key segment, which is why the id is minted by the application
rather than by the database: the object has to be written first, so that a
failure leaves an object nothing points at rather than a row pointing at
nothing. The row is what every read path uses; the bucket is consulted only for
bytes.

⚠️ **Two different meanings of "resume" collide here, and one of them is a key
segment.** The storage _kind_ is `resumes`, so an object key reads
`prod/{userId}/resumes/{id}.pdf` no matter what the document actually is; a cover
letter is stored under `resumes` too. Meanwhile **Resume** is also one of the six
selectable **Document Types**. The kind is not renamed because a kind is a key
segment, an object tag and a file-type allowlist at once — the tag is what the S3
lifecycle rules filter on, so renaming it would orphan every existing object's
retention. Read `resumes` as "the shelf uploads go on", not as "these are all
CVs".
_Avoid_: file, attachment, upload (as a noun)

**Document Type**:
What the user says a **Document** is: `resume`, `cover-letter`, `portfolio`,
`reference`, `certification` or `other`. A `doc_type` column on `documents`, text
plus a CHECK rather than a Postgres enum. Emphatically **not** a storage kind of
its own — a separate kind buys only separate retention and separate accepted file
types, and these six want neither: one shelf, one retention policy, seven file
types, labelled.

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

**Trace**:
The transcript of one agent turn — every prompt, model message and tool round
trip — sent to Langfuse over OpenTelemetry through `@workspace/langfuse`. The
dashboard sends two: `chat-response` from the Assistant and `whiteboard-turn`
from the **Whiteboard**. Nothing else records what a turn did — no row is written
for a chat message, and a whiteboard turn leaves only the **Snapshot** it
changed — so the trace is the only place a prompt survives and the only thing
that can answer "why did it do that".

Missing keys make it a no-op rather than an error, so tracing is a thing a
runtime opts into, and a turn behaves identically either way.
_Avoid_: log, debug output, history

**Whiteboard**:
The shared infinite canvas at `/whiteboard`, one per **User**, that the user and
an agent draw on at the same time. The only agent that writes to something the
user is simultaneously editing.

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
turn (`createBoardSession` in `packages/agent-tools/src/whiteboard/session.ts`),
and lives only so the fourth tool call can name the shape the first one created.
The browser remains the source of truth; drift is bounded to a turn and repaired
by the next one's Board Context.

_Avoid_: canvas state, drawing, diagram (a **Whiteboard** holds diagrams; it is
not one)

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
