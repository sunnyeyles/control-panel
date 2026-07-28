# user-storage

A private, encrypted, versioned S3 bucket for per-user data — generated briefs
and uploaded documents — plus least-privilege IAM policies per environment and
per kind.

Self-contained on purpose: it creates the bucket and its guards and nothing
else, so it can be dropped into whatever root eventually owns the AWS stack.
See `infra/aws/README.md` for the rationale, the key layout, and the handoff to
the workload's stack.

## Usage

```hcl
module "user_storage" {
  source = "./modules/user-storage"

  bucket_name  = "control-panel-user-storage-<suffix>"
  environments = ["prod"]
}
```

Grant a workload access to one kind only — the narrow form, and the one to
reach for first:

```hcl
resource "aws_iam_role_policy_attachment" "briefs" {
  role       = aws_iam_role.worker.name
  policy_arn = module.user_storage.kind_access_policy_arns["prod:briefs"]
}
```

## Inputs

| Name                   | Type                | Default             | Description                                                     |
| ---------------------- | ------------------- | ------------------- | --------------------------------------------------------------- |
| `bucket_name`          | `string`            | —                   | Globally unique. Validated against S3's naming rules.           |
| `environments`         | `list(string)`      | — (required)        | One key prefix and one IAM policy each.                         |
| `object_kinds`         | `map(object)`       | `briefs`, `resumes` | Categories and their retention. See below.                      |
| `kms_key_arn`          | `string`            | `null`              | Null uses SSE-S3. Set only when a key you rotate is required.   |
| `attach_to_role_names` | `map(list(string))` | `{}`                | Roles to attach each environment's policy to. Creates no roles. |
| `tags`                 | `map(string)`       | `{}`                | Applied verbatim; this module adds none of its own.             |

`environments` has **no default**. The caller's root declares one — and passing
`null` to a module input does not fall back to a module default, so a default
here would be dead code that nonetheless reads as authoritative. Requiring it
also means no deployment silently gets an environment layout it never chose.

`environments` is validated against the same key-segment rule the TypeScript
enforces in `packages/user-storage/src/keys.ts`. A name containing a slash or a
dot-segment would break prefix scoping on both sides, so it is rejected here
too rather than only at runtime.

### `object_kinds`

Keys must match the kinds declared in `packages/user-storage/src/kinds.ts`.

```hcl
object_kinds = {
  briefs  = { expiration_days = 365,  noncurrent_version_expiration_days = 30 }
  resumes = { expiration_days = null, noncurrent_version_expiration_days = 365 }
}
```

`expiration_days = null` means **never expire**, and that is the default for
resumes on purpose: silently deleting a document the user uploaded themselves
is data loss, not housekeeping. When it is null no `expiration` block is
emitted at all — the absence is the guarantee, rather than a very large number.

## How per-kind retention actually works

Not by prefix, and the reason is worth knowing before editing this module.

S3 lifecycle filters match a **literal** prefix — no wildcards. The key layout
is `environment/userId/kind/…`, so there is no prefix meaning "every user's
briefs": `userId` sits between the two fixed parts. Putting kind above userId
would fix lifecycle but scatter a user's data across kinds, making erasure N
deletes instead of one.

So the store tags every object `kind=<kind>` at write time, and these rules
filter on the tag. Consequences:

- The access policies must include **`s3:PutObjectTagging`**. Without it the
  write 403s.
- A kind added to `kinds.ts` with no matching entry here gets **no retention
  policy at all**. It will not error; it will just accumulate.

IAM is different — resource ARNs _do_ take wildcards, which is why per-kind
policies below can be expressed as `…/{environment}/*/{kind}/*`.

## Outputs

| Name                      | Description                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `bucket_name`             | Set as `USER_STORAGE_BUCKET_NAME`.                                |
| `bucket_arn`              | For policies written outside this module.                         |
| `bucket_region`           | Set as `AWS_REGION`.                                              |
| `access_policy_arns`      | Per environment, every kind. The broad grant.                     |
| `kind_access_policy_arns` | Per `<environment>:<kind>`, e.g. `prod:briefs`. The narrow grant. |

## What it does not do

- **No IAM role.** The execution role belongs to the workload's stack; creating
  it here would make two stacks contend over one resource.
- **No public access of any kind.** No website configuration, no ACL, no
  presigned-URL machinery.
- **No bucket-level delete grant.** The access policies cover objects only.

The bucket carries `prevent_destroy`, because it holds documents the user
uploaded themselves — the one thing here no apply can recreate. `terraform
destroy` on a root containing this module fails until that block is removed,
which is the intent.
