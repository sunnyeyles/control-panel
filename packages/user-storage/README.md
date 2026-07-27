# @workspace/user-storage

Per-user object storage — Markdown briefs the worker generates, documents the
user uploads. S3 behind an interface.

## The seam

```
kinds.ts               the categories, their file types, their dispositions   no AWS import
keys.ts                build / parse / validate object keys                   no AWS import
errors.ts              the typed error union                                  no AWS import
config.ts              reads the environment                                  no AWS import
user-object-store.ts   the UserObjectStore interface                          no AWS import
brief-store.ts         BriefStore facade                                      no AWS import
resume-store.ts        ResumeStore facade                                     no AWS import
s3-user-object-store.ts  createS3UserObjectStore()                            the only AWS import
```

One generic core does the S3 work, key validation, ownership checks and error
mapping. Two thin facades sit on top and know their own kind's key shape and
file types, so a call site does not have to restate them — and cannot get them
wrong.

Compose once, at the composition root:

```ts
import {
  createS3UserObjectStore,
  createBriefStore,
  createResumeStore,
} from "@workspace/user-storage"

const objects = createS3UserObjectStore()
const briefs = createBriefStore(objects)
const resumes = createResumeStore(objects)
```

Everything downstream takes the narrow type:

```ts
import type { BriefStore } from "@workspace/user-storage"

async function persist(briefs: BriefStore, markdown: string) {
  return briefs.put({
    userId: "alice",
    briefId: "morning",
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
are not, because they are uploaded and replaced.

`environment` is **not** part of any ref. It comes from the store's own config,
so a caller cannot reach into another environment however it is called — the
same boundary the IAM policy draws.

### What this layout costs

S3 **lifecycle** filters match a literal prefix and accept no wildcards, so
with `userId` in the middle there is no prefix meaning "every user's briefs".
Retention could not differ per kind on prefixes alone.

So every object is **tagged** `kind=<kind>` at write time and the lifecycle
rules filter on that tag. It is the only reason briefs and resumes can be
retained differently. Adding a kind to `kinds.ts` without a matching entry in
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

| Kind      | Extensions                           | Disposition  |
| --------- | ------------------------------------ | ------------ |
| `briefs`  | `.md`                                | `inline`     |
| `resumes` | `.pdf .doc .docx .odt .rtf .txt .md` | `attachment` |

`attachment` on uploaded documents matters: those bytes arrived from outside,
and a browser rendering an uploaded file inline on the bucket's origin is the
standard stored-XSS route. Nothing is served directly from S3 today, so it is
currently belt-and-braces — it becomes load-bearing if presigned URLs are ever
added.

Bodies accept `string` (encoded UTF-8, with a byte-accurate `Content-Length`)
or `Uint8Array` (stored verbatim, which an uploaded PDF requires).

An uploaded filename is recorded as metadata and **never** used as a key
segment or an identifier — it is attacker-controlled text, and using it as a
path is the classic traversal. It is reduced to its basename and stripped of
anything an HTTP header cannot carry, since S3 metadata travels in headers.

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

Per environment **and** per kind, so "the worker can write briefs" and "the
worker can delete a user's CV" are not the same grant:

- `s3:PutObject`, `s3:PutObjectTagging`, `s3:GetObject`, `s3:GetObjectTagging`,
  `s3:DeleteObject` on `{bucket}/{environment}/*/{kind}/*`
- `s3:ListBucket` on `{bucket}`, `s3:prefix` like `{environment}/*/{kind}/*`

`PutObjectTagging` is not optional — the write 403s without it, and the
lifecycle rules depend on the tag it sets. `HeadObject` is authorised by
`s3:GetObject`. `infra/aws/modules/user-storage` emits exactly these and
exports the ARNs.

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
