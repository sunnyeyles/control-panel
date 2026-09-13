# @workspace/user-storage

Per-user object storage — documents the user uploads. S3 behind an interface.

## The seam

```
kinds.ts               the categories, their file types, their dispositions   no AWS import
keys.ts                build / parse / validate object keys                   no AWS import
errors.ts              the typed error union                                  no AWS import
config.ts              reads the environment                                  no AWS import
user-object-store.ts   the UserObjectStore interface                          no AWS import
metadata.ts            cleaning a value a header can carry                    no AWS import
resume-store.ts        ResumeStore facade                                     no AWS import
memory-object-store.ts in-memory UserObjectStore for tests                    no AWS import
s3-user-object-store.ts  createS3UserObjectStore()                            the only AWS import
```

One generic core does the S3 work, key validation, ownership checks and error
mapping. A thin facade sits on top and knows its kind's key shape and file
types, so a call site does not have to restate them — and cannot get them wrong.

`metadata.ts` is not decoration: **S3 user-metadata values travel in HTTP
headers**, so a value carrying a newline is header injection and a non-ASCII one
is silently mangled. An uploaded filename and a Document Type are both text from
outside, so both go through `toMetadataValue`.

Compose once, at the composition root:

```ts
import {
  createResumeStore,
  createS3UserObjectStore,
} from "@workspace/user-storage"

const objects = createS3UserObjectStore()
const resumes = createResumeStore(objects)
```

Everything downstream takes the narrow type:

```ts
import type { ResumeStore } from "@workspace/user-storage"

async function upload(resumes: ResumeStore, bytes: Uint8Array) {
  return resumes.put({
    userId: "alice",
    // Minted by the application, never the uploaded filename.
    resumeId: crypto.randomUUID(),
    extension: ".pdf",
    bytes,
    originalFilename: "My CV.pdf",
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
SDK resolves them through its default provider chain — or, in the dashboard, a
`client` built with Vercel's OIDC provider — and `AWS_PROFILE` or an SSO session
locally. `createS3UserObjectStore` accepts a `config` and a `client`, and
nothing else.

Configuration is read by a **call**, not at import time. Importing this package
never throws, so a build, a typecheck, or a consumer that only wants the key
helpers does not need a bucket to point at. This mirrors `getOpenAIApiKey` in
`@workspace/agents-core`.

## Object keys

```
{environment}/{userId}/{kind}/…tail.{ext}

prod/alice/resumes/backend-2026.pdf
```

Environment leads so one bucket holds several without their IAM prefixes
overlapping. **`userId` sits above `kind`** so one `s3:prefix` condition scopes
an identity to one user, and — the deciding reason — so erasing a user is a
single prefix rather than one per kind. Kind comes third so an IAM policy can
still narrow to a category: IAM resource ARNs take wildcards, so
`…/prod/*/resumes/*` is expressible.

The tail is the kind's business, which is the reason the core is generic. A
resume's is a flat id, because it is uploaded and replaced.

`environment` is **not** part of any ref. It comes from the store's own config,
so a caller cannot reach into another environment however it is called — the
same boundary the IAM policy draws.

### What this layout costs

S3 **lifecycle** filters match a literal prefix and accept no wildcards, so
with `userId` in the middle there is no prefix meaning "every user's resumes".
Retention could not differ per kind on prefixes alone.

So every object is **tagged** `kind=<kind>` at write time and the lifecycle
rules filter on that tag. Adding a kind to `kinds.ts` without a matching entry
in the Terraform `object_kinds` map leaves it with no retention policy at all.

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

| Kind      | Extensions                           | Disposition  |
| --------- | ------------------------------------ | ------------ |
| `resumes` | `.pdf .doc .docx .odt .rtf .txt .md` | `attachment` |

`attachment` on uploaded documents matters: those bytes arrived from outside,
and a browser rendering an uploaded file inline on the bucket's origin is the
standard stored-XSS route. **This is load-bearing**, not belt-and-braces:
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

`ResumeStore` also stamps an optional **document type** (`document-type`
metadata) beside it.

⚠️ **Both of those are written and never read back, and that is the point.** A
Document's filename and its Document Type live in `documents` in Postgres, which
is what the application reads; what is on the object is provenance. Keeping it
means an object in the bucket still describes itself — which is what an operator
staring at a key has to go on, and what would make a backfill possible if the
table were ever lost. `StoredResume` therefore carries `originalFilename` and no
`documentType` at all: offering the label here would be offering a value that
goes stale the moment a row is relabelled.

This package holds **no list of valid document types**, and must not grow one.
That list is `DOCUMENT_TYPES` in `@workspace/db` plus a CHECK on
`documents.doc_type` — one gate, in the place that can actually enforce it — and
`@workspace/db` is not a dependency of this package. `NewResume.documentType` is
a plain `string`, cleaned through `toMetadataValue` like every other
caller-supplied value and otherwise taken as given.

A Document Type was never a storage kind and still is not. A kind buys separate
retention and separate accepted extensions, and these six want neither — six
kinds would cost six `kinds.ts` entries, six Terraform `object_kinds` entries and
six IAM policies to label one shelf of documents.

⚠️ **`list()` returns no user metadata at all.** ListObjectsV2 does not carry
it, so every listed object has `metadata: {}` — meaning `originalFilename` is
always `undefined` from a listing, while `key`, `size` and `storedAt` are real.
The Documents page does not use it: that listing is a query. What `list()`
answers is "what is actually in the bucket", which is the question a
reconciliation or a backfill asks rather than the one a page does.

## Errors

Every method rejects with a `UserStorageError` — never a raw SDK error.

| Class                     | `code`                | Means                                     |
| ------------------------- | --------------------- | ----------------------------------------- |
| `InvalidObjectKeyError`   | `invalid_object_key`  | Malformed key, part, or file type         |
| `ObjectNotFoundError`     | `object_not_found`    | Nothing stored there                      |
| `ObjectOwnershipError`    | `object_ownership`    | Exists, belongs to someone else           |
| `StorageUnavailableError` | `storage_unavailable` | The store refused or could not be reached |

Branch on `code`, not `instanceof`. A bundled consumer can end up with two
copies of this package, and `instanceof` silently stops matching across them.

`AccessDenied` maps to `storage_unavailable`, not `object_not_found` — a policy
that forbids the read is the store being unavailable. `NoSuchBucket` maps there
too, though it is also a 404: a missing bucket is a misconfigured
`USER_STORAGE_BUCKET_NAME`, and calling it not-found sends whoever is debugging
it looking for the wrong thing.

## IAM

Grants are per environment **and** per kind, so reading a user's CV and deleting
one are not the same grant. `infra/aws/README.md` §Least privilege has the
rendered policies and the reasoning; `infra/aws/modules/user-storage` emits them
and exports the ARNs.

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
without typechecking. The facade is tested against an in-memory
`UserObjectStore` and the S3 adapter against a fake client; no test in this
package makes a network call.
