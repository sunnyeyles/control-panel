import { S3Client } from "@aws-sdk/client-s3"
import { getDevResumeStore } from "@/lib/dev/fake-stores"
import { devMockEnabled } from "@/lib/dev/mode"
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider"
import {
  createResumeStore,
  createS3UserObjectStore,
  readUserStorageConfig,
  type ResumeStore,
  type UserObjectStore,
  type UserStorageConfig,
} from "@workspace/user-storage"

/**
 * The dashboard's document storage, one per server instance.
 *
 * ⚠️ **The second module in the repository to import `@aws-sdk/client-s3`**, and
 * credentials are why. `@workspace/user-storage` deliberately exposes no way to
 * pass any — a package that accepts a credential is one someone hard-codes a key
 * into — only a `client` seam, so the decision lives at the composition root
 * that owns configuration. Do not "fix" this by adding a `credentials` option to
 * the package.
 *
 * Memoized rather than per-request, matching `lib/db.ts`: an `S3Client` holds a
 * connection pool. Still a function, because constructing it reads
 * configuration and configuration is read on demand, not at import time.
 *
 * ⚠️ Nothing here runs during `next build`, so a missing
 * `USER_STORAGE_BUCKET_NAME` surfaces at the first upload and a green build says
 * less about this file than most.
 */
let objects: UserObjectStore | undefined
let resumes: ResumeStore | undefined

/**
 * The role the memoized client assumes, or `undefined` for the default chain.
 *
 * The role ARN *is* the identity, so it is the whole memo key — otherwise a
 * changed role leaves the existing client assuming the old one. `!objects` is
 * what distinguishes "never built" from "built for the default chain".
 */
let builtFor: string | undefined

/**
 * Documents the user uploaded.
 *
 * The facade is memoized alongside the client it wraps, so "is this the same
 * store" does not get a different answer every request.
 */
export function getResumeStore(): ResumeStore {
  // Before `getObjectStore()` reads the storage config and builds an `S3Client`
  // — the two things this mode exists to not need. ⚠️ Memoized inside the dev
  // module, not here: `next dev` can hand two server bundles two copies of this
  // module, and two copies of an in-memory store are two worlds.
  if (devMockEnabled()) return getDevResumeStore()

  const store = getObjectStore()
  resumes ??= createResumeStore(store)
  return resumes
}

/**
 * The one client every facade shares.
 *
 * Shared so a facade cannot build its own `S3Client`, connection pool, and
 * opportunity to be pinned to a stale credential branch.
 */
function getObjectStore(): UserObjectStore {
  // ⚠️ **The credential source is recomputed every call; only the client is
  // memoized.** Deciding the OIDC-vs-default-chain branch once pins an instance
  // that came up before `AWS_ROLE_ARN` was in place to the default chain for
  // life, failing every upload as "Document storage is unavailable". Cheap to
  // re-read a string; expensive to diagnose. In the steady state the answer
  // never changes, so nothing is rebuilt.
  const roleArn = oidcRoleArn()

  if (!objects || builtFor !== roleArn) {
    const config = readUserStorageConfig()

    objects = createS3UserObjectStore({
      config,
      client: createClient(config, roleArn),
    })
    builtFor = roleArn

    // ⚠️ The facade closes over the client, so a rebuild must invalidate it
    // too. **Any facade added above needs a line here** — one left out keeps
    // assuming the previous role for the life of the instance, silently.
    resumes = undefined
  }

  return objects
}

/**
 * The role to assume on Vercel, or `undefined` anywhere else.
 *
 * ⚠️ **Do not gate this on `VERCEL_OIDC_TOKEN`.** `@vercel/oidc` resolves the
 * token as a **per-request header** —
 * `getContext().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN`
 * — with the variable only a `vercel env pull` fallback. On a real deployment
 * nothing sets it, so the gate is always false, `createClient` takes its
 * no-credentials branch, and every upload fails with `Could not load credentials
 * from any providers`: a message naming no role, so it reads as a missing IAM
 * attachment. The tell is that STS is never called at all — a trust-policy or
 * audience mismatch would still leave a CloudTrail event.
 *
 * `AWS_ROLE_ARN` is the right signal: it says *assume a role* and is set only
 * where that is wanted. Safe at build time despite `VERCEL=1`, since
 * `awsCredentialsProvider` is lazy and nothing here runs during `next build`.
 */
function oidcRoleArn(): string | undefined {
  return process.env.AWS_ROLE_ARN
}

/**
 * On Vercel, credentials come from an OIDC token exchanged for a role; anywhere
 * else they come from the SDK's own default chain.
 *
 * Three things, each of which looks like a simplification waiting to happen:
 *
 * 1. **Memoize the client, not the credentials.** `awsCredentialsProvider`
 *    returns a provider *function* the SDK re-calls as expiry approaches, so one
 *    long-lived client staples no expiring credential to the instance. If
 *    `ExpiredToken` ever appears, stop memoizing the client — never reach for a
 *    static access key. Memoizing *which branch was taken* is the part that is
 *    not fine; the caller re-reads the environment and passes the answer in.
 * 2. **Branch on `AWS_ROLE_ARN` and nothing else** — see `oidcRoleArn`, which is
 *    where that mistake was made.
 * 3. **`AWS_ROLE_ARN` collides with the SDK's own `fromTokenFile` provider.** It
 *    never fires, because that also needs `AWS_WEB_IDENTITY_TOKEN_FILE` and
 *    Vercel sets none — a coincidence of conventions, not a guarantee, so the
 *    explicit branch below is what decides.
 *
 * Locally (`next dev`, not `vercel dev`) there is no token, so this falls to the
 * default chain. ⚠️ A local run therefore writes to whatever
 * `USER_STORAGE_ENVIRONMENT` says, and there is only one environment.
 */
function createClient(
  config: UserStorageConfig,
  roleArn: string | undefined
): S3Client {
  if (!roleArn) return new S3Client({ region: config.region })

  return new S3Client({
    region: config.region,
    credentials: awsCredentialsProvider({ roleArn }),
  })
}
