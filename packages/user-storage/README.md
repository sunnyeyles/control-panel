# @workspace/user-storage

Per-user object storage — Markdown briefs the worker generates, cover letters the
dashboard drafts, documents the user uploads. S3 behind an interface.

## The seam

```
kinds.ts               the categories, their file types, their dispositions   no AWS import
keys.ts                build / parse / validate object keys                   no AWS import
errors.ts              the typed error union                                  no AWS import
config.ts              reads the environment                                  no AWS import
user-object-store.ts   the UserObjectStore interface                          no AWS import
metadata.ts            cleaning a value a header can carry                    no AWS import
brief-store.ts         BriefStore facade                                      no AWS import
cover-letter-store.ts  CoverLetterStore facade                                no AWS import
tailored-resume-store.ts  TailoredResumeStore facade                          no AWS import
resume-store.ts        ResumeStore facade                                     no AWS import
s3-user-object-store.ts  createS3UserObjectStore()                            the only AWS import
```

One generic core does the S3 work, key validation, ownership checks and error
mapping. Four thin facades sit on top and know their own kind's key shape and
file types, so a call site does not have to restate them — and cannot get them
wrong.

`metadata.ts` is shared by three of them and is not decoration: **S3 user-metadata
values travel in HTTP headers**, so a value carrying a newline is header
injection and a non-ASCII one is silently mangled. An uploaded filename, a cover
letter's provenance and a tailored resume's are all text from outside, so all go
through `toMetadataValue`.

⚠️ **Only `TailoredResumeStore` and `ResumeStore` have a `list()`, and the
asymmetry is deliberate.** `CoverLetterStore` does not, which is why rendering
"does one exist for this Posting" down a table costs it one `HeadObject` per row
— see `docs/cover-letter-existence-plan.md`. The tailored resume was built with
`list()` from the start rather than repeating that. The cost of having it is that
a listing carries **no user metadata**: every entry comes back with empty
provenance and a date taken from the object's own write time, so anything
rendering a filename or a company must `get()` or `head()` the one object it is
showing.

Compose once, at the composition root:

```ts
import {
  createS3UserObjectStore,
  createBriefStore,
  createCoverLetterStore,
  createResumeStore,
  createTailoredResumeStore,
} from "@workspace/user-storage"

const objects = createS3UserObjectStore()
const briefs = createBriefStore(objects)
const resumes = createResumeStore(objects)
const coverLetters = createCoverLetterStore(objects)
const tailoredResumes = createTailoredResumeStore(objects)
```

Everything downstream takes the narrow type:

```ts
import type { BriefStore } from "@workspace/user-storage"

async function persist(
  briefs: BriefStore,
  scheduledFor: Date,
  markdown: string
) {
  return briefs.put({
    userId: "alice",
    briefId: "morning",
    // The slot this brief is for, which decides the key's UTC partition day.
    occurrence: scheduledFor,
    // When it was actually produced. Metadata only — it no longer decides the
    // key, so a 23:30 slot finishing after midnight still files under its own
    // day rather than the next one.
    generatedAt: new Date(),
    markdown,
  })
}
```

## Environment

| Variable                   | Required | Meaning                                                  |
| -------------------------- | -------- | -------------------------------------------------------- |
| `USER_STORAGE_BUCKET_NAME` | yes      | Bucket holding every environment's user data             |
| `USER_STORAGE_ENVIRONMENT` | yes      | Leading key segment — `dev`, `prod`                      |
| `AWS_REGION`               | yes      | Bucket region. `AWS_DEFAULT_REGION` is accepted instead. |

`terraform -chdir=infra/aws output` prints the first and third.

**Credentials are not on that list, and there is no way to pass them.** The AWS
SDK resolves them through its default provider chain — the Lambda execution
role in production, `AWS_PROFILE` or an SSO session locally.
`createS3UserObjectStore` accepts a `config` and a `client`, and nothing else.

Configuration is read by a **call**, not at import time. Importing this package
never throws, so a build, a typecheck, or a consumer that only wants the key
helpers does not need a bucket to point at. This mirrors `getOpenAIApiKey` in
`@workspace/agents-core`.

## Object keys

```
{environment}/{userId}/{kind}/…tail.{ext}

prod/alice/briefs/2026/07/28/morning.md
prod/alice/cover-letters/0f1e2d3c4b5a6978.md
prod/alice/resumes/backend-2026.pdf
```

Environment leads so one bucket holds several without their IAM prefixes
overlapping. **`userId` sits above `kind`** so one `s3:prefix` condition scopes
an identity to one user, and — the deciding reason — so erasing a user is a
single prefix rather than one per kind. Kind comes third so an IAM policy can
still narrow to a category: IAM resource ARNs take wildcards, so
`…/prod/*/resumes/*` is expressible.

The tail differs per kind, which is the whole reason the core is generic.
Briefs are date-partitioned because they are generated on a schedule; resumes
are not, because they are uploaded and replaced. A cover letter's tail is the
**Posting** id and nothing else, so the unit of identity is (user, Posting) —
re-drafting the same advertisement overwrites one object rather than
accumulating, and the Run that found it lives in metadata instead.

`environment` is **not** part of any ref. It comes from the store's own config,
so a caller cannot reach into another environment however it is called — the
same boundary the IAM policy draws.

### What this layout costs

S3 **lifecycle** filters match a literal prefix and accept no wildcards, so
with `userId` in the middle there is no prefix meaning "every user's briefs".
Retention could not differ per kind on prefixes alone.

So every object is **tagged** `kind=<kind>` at write time and the lifecycle
rules filter on that tag. It is the only reason briefs, resumes and cover
letters can be retained differently — briefs expire after a year, the other two
never do. Adding a kind to `kinds.ts` without a matching entry in
the Terraform `object_kinds` map leaves it with no retention policy at all.

## Ownership and validation

Every key segment is checked against
`[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]`. That is the ownership boundary,
not a tidiness rule: an unvalidated `userId` of `../someone-else` addresses
another user's prefix. Leading and trailing dots are excluded, so `.` and `..`
are unrepresentable.

Ownership is enforced twice — **structurally**, since the key is derived from
the caller's own `userId`, and **on read**, where `get`, `head` and `delete`
compare the object's `user-id` metadata against the caller and throw
`ObjectOwnershipError` on a mismatch. `delete` heads first: `DeleteObject`
succeeds on a key that was never there, so without the head a caller deleting a
typo would be told it worked.

Caller-supplied metadata cannot overwrite `user-id`, `kind` or `environment`.
Without that rule, passing `{ "user-id": "someone-else" }` would write an
object that passes its own ownership check.

## File types and content

**The media type is derived from the extension, never accepted from the
caller.** A caller-supplied content type is a caller-supplied claim; it would
let a `.pdf` be stored as `text/html`. Each kind declares an allowlist in
`kinds.ts`, and an extension outside it is rejected before any request is made.

| Kind               | Extensions                           | Disposition  |
| ------------------ | ------------------------------------ | ------------ |
| `briefs`           | `.md`                                | `inline`     |
| `cover-letters`    | `.md`                                | `inline`     |
| `tailored-resumes` | `.md`                                | `inline`     |
| `resumes`          | `.pdf .doc .docx .odt .rtf .txt .md` | `attachment` |

`attachment` on uploaded documents matters: those bytes arrived from outside,
and a browser rendering an uploaded file inline on the bucket's origin is the
standard stored-XSS route. **This is load-bearing now**, not belt-and-braces:
`apps/dashboard/app/api/documents/[file]/route.ts` serves these bytes back to a
browser, and it passes the stored disposition and content type straight through
alongside `X-Content-Type-Options: nosniff`. Nothing is served directly from S3
— the route reads through this package — but the browser still receives the
upload.

Bodies accept `string` (encoded UTF-8, with a byte-accurate `Content-Length`)
or `Uint8Array` (stored verbatim, which an uploaded PDF requires).

An uploaded filename is recorded as metadata and **never** used as a key
segment or an identifier — it is attacker-controlled text, and using it as a
path is the classic traversal. It is reduced to its basename and stripped of
anything an HTTP header cannot carry, since S3 metadata travels in headers.

`ResumeStore` also records an optional **document type** (`document-type`
metadata): one of `resume`, `cover-letter`, `portfolio`, `reference`, `other`.
It is validated against that allowlist in both directions — on write because it
crosses a form boundary, and on read because an object written by older code or
edited by hand carries whatever it carries; an unrecognised value reads back as
`undefined`. Absent is legitimate, since nothing written before the field
existed has one.

It is metadata rather than a kind on purpose. A kind buys separate retention and
separate accepted extensions, and these five want neither — five kinds would
cost five `kinds.ts` entries, five Terraform `object_kinds` entries and five IAM
policies to label one shelf of documents. The cost is that S3 metadata is
immutable without a copy, and no method here exposes one, so a type is fixed at
upload.

⚠️ **`list()` returns no user metadata at all.** ListObjectsV2 does not carry
it, so every listed object has `metadata: {}` — meaning `originalFilename` and
`documentType` are always `undefined` from a listing, while `key`, `size` and
`storedAt` are real. Recovering either means a `head()` per object.
`apps/dashboard/lib/documents/list-documents.ts` does exactly that, and explains
why the N+1 is the right trade at this scale.

## Errors

Every method rejects with a `UserStorageError` — never a raw SDK error.

| Class                     | `code`                | Means                                     |
| ------------------------- | --------------------- | ----------------------------------------- |
| `InvalidObjectKeyError`   | `invalid_object_key`  | Malformed key, part, or file type         |
| `ObjectNotFoundError`     | `object_not_found`    | Nothing stored there                      |
| `ObjectOwnershipError`    | `object_ownership`    | Exists, belongs to someone else           |
| `StorageUnavailableError` | `storage_unavailable` | The store refused or could not be reached |

Branch on `code`, not `instanceof`. A bundled worker can end up with two copies
of this package, and `instanceof` silently stops matching across them.

`AccessDenied` maps to `storage_unavailable`, not `object_not_found` — a policy
that forbids the read is the store being unavailable. `NoSuchBucket` maps there
too, though it is also a 404: a missing bucket is a misconfigured
`USER_STORAGE_BUCKET_NAME`, and calling it not-found sends whoever is debugging
it looking for the wrong thing.

## IAM

Grants are per environment **and** per kind, so "the worker can write briefs"
and "the worker can delete a user's CV" are not the same grant.
`infra/aws/README.md` §Least privilege has the rendered policies and the
reasoning; `infra/aws/modules/user-storage` emits them and exports the ARNs.

The one thing to carry back into this package: **`PutObjectTagging` is not
optional.** Every `put` here tags the object with its kind, so the write 403s
without it and the lifecycle rules have nothing to filter on.

## Commands

```bash
pnpm turbo build     --filter=@workspace/user-storage
pnpm turbo test      --filter=@workspace/user-storage
pnpm turbo typecheck --filter=@workspace/user-storage
pnpm turbo lint      --filter=@workspace/user-storage
```

Tests are Vitest, beside the code they cover, and excluded from the build's
`tsconfig.json` so they never reach `dist/`. `typecheck` runs twice — once for
`src`, once via `tsconfig.test.json` for the tests, because Vitest transpiles
without typechecking. The facades are tested against an in-memory
`UserObjectStore` and the S3 adapter against a fake client; no test in this
package makes a network call.
