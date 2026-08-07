import { S3Client } from "@aws-sdk/client-s3"
import {
  getDevCoverLetterStore,
  getDevResumeStore,
  getDevTailoredResumeStore,
} from "@/lib/dev/fake-stores"
import { devMockEnabled } from "@/lib/dev/mode"
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider"
import {
  createCoverLetterStore,
  createResumeStore,
  createS3UserObjectStore,
  createTailoredResumeStore,
  readUserStorageConfig,
  type CoverLetterStore,
  type ResumeStore,
  type TailoredResumeStore,
  type UserObjectStore,
  type UserStorageConfig,
} from "@workspace/user-storage"

/**
 * The dashboard's document storage, one per server instance.
 *
 * ⚠️ **This is the second module in the repository to import
 * `@aws-sdk/client-s3`**, and until this file existed `s3-user-object-store.ts`
 * was the only one — `CLAUDE.md` and `OVERVIEW.md` both said so. The reason it
 * has to be here is credentials: `@workspace/user-storage` deliberately exposes
 * no way to pass any ("Note what is *not* here: any way to pass credentials"),
 * because a package that accepts a credential is a package someone hard-codes a
 * key into. What it does expose is a `client` seam, so the credential decision
 * lives at the composition root that already owns configuration — here. Do not
 * "fix" this by adding a `credentials` option to the package.
 *
 * Memoized rather than constructed per request, matching `lib/db.ts`: an
 * `S3Client` maintains a connection pool and a serverless instance handling
 * many requests should not build many. Still a function rather than a
 * module-level `const`, because constructing it reads configuration, and this
 * repo's rule is that configuration is read when something asks for it and not
 * at import time.
 *
 * A consequence worth knowing: nothing here runs during `next build`. A missing
 * `USER_STORAGE_BUCKET_NAME` surfaces at the first upload, not at build time,
 * so a green build says less about this file than it does about most.
 */
let objects: UserObjectStore | undefined
let resumes: ResumeStore | undefined
let coverLetters: CoverLetterStore | undefined
let tailoredResumes: TailoredResumeStore | undefined

/**
 * The role the memoized client assumes, or `undefined` for the default chain.
 *
 * The role ARN *is* the identity, so it is also the whole memo key: changing it
 * is a change of identity, and the existing client would otherwise keep
 * assuming the role it was built with. `undefined !== undefined` is `false`, so
 * the default-chain case memoizes exactly as well as the OIDC one; `!resumes`
 * is what distinguishes "never built" from "built for the default chain".
 */
let builtFor: string | undefined

/**
 * Documents the user uploaded.
 *
 * The facade is memoized alongside the client it wraps — building one is a
 * closure over an interface and costs nothing, but rebuilding it per request
 * would make "is this the same store" a question with a different answer every
 * time, which is the sort of thing a future caching layer would get wrong.
 */
export function getResumeStore(): ResumeStore {
  // Before `getObjectStore()` reads the storage config and builds an
  // `S3Client` — the two things this mode exists to not need.
  // Memoized inside the dev module rather than here: `next dev` can hand two
  // server bundles two copies of this module, and two copies of an in-memory
  // store are two different worlds. See `getDevResumeStore`.
  if (devMockEnabled()) return getDevResumeStore()

  const store = getObjectStore()
  resumes ??= createResumeStore(store)
  return resumes
}

/**
 * Cover letters this app drafts.
 *
 * A second facade over the **same** client and the same credentials — the
 * dashboard's Vercel role now holds `prod:resumes` and `prod:cover-letters`,
 * and nothing else. Note what that grant does not include: `prod:briefs`. The
 * app still cannot read what the worker wrote, which is why `/briefings`
 * renders the Findings on the Run row rather than the Brief.
 *
 * ⚠️ **The grant is Terraform, not TypeScript.** A `cover-letters` kind
 * declared in `packages/user-storage/src/kinds.ts` without the matching
 * `object_kinds` entry and role attachment in `infra/aws/` gets no retention
 * rule and 403s on the first write — surfacing here as nothing more specific
 * than "Document storage is unavailable".
 */
export function getCoverLetterStore(): CoverLetterStore {
  if (devMockEnabled()) return getDevCoverLetterStore()

  const store = getObjectStore()
  coverLetters ??= createCoverLetterStore(store)
  return coverLetters
}

/**
 * Resumes this app rewrites for one Posting.
 *
 * A third facade over the **same** client and the same credentials. The
 * dashboard's Vercel role holds `prod:resumes`, `prod:cover-letters` and
 * `prod:tailored-resumes`, and still not `prod:briefs`.
 *
 * ⚠️ **The grant is Terraform, not TypeScript** — the same warning as the
 * letters above, and it is not hypothetical here: this kind is new, so until
 * `terraform -chdir=infra/aws apply` has run there is no lifecycle rule and no
 * role attachment for it, and the first **Generate tailored resume** click 403s
 * with nothing more specific on screen than "Document storage is unavailable".
 */
export function getTailoredResumeStore(): TailoredResumeStore {
  if (devMockEnabled()) return getDevTailoredResumeStore()

  const store = getObjectStore()
  tailoredResumes ??= createTailoredResumeStore(store)
  return tailoredResumes
}

/**
 * The one client every facade shares.
 *
 * Split out of `getResumeStore` when the second facade arrived: independent
 * memos would have meant several `S3Client`s, several connection pools, and
 * several opportunities for one of them to be left pinned to a stale credential
 * branch.
 */
function getObjectStore(): UserObjectStore {
  // ⚠️ **The credential source is recomputed every call; only the client is
  // memoized.**
  //
  // `createClient` decides between OIDC and the SDK's default chain by reading
  // the environment. Deciding that once, at whatever moment the first request
  // happened to arrive, means an instance that came up before `AWS_ROLE_ARN`
  // was in place is pinned to the default chain for its whole life — and every
  // upload it serves fails on absent credentials, which `DEPLOYING.md` has to
  // warn surfaces as nothing more specific than "Document storage is
  // unavailable". Cheap to re-read a string; expensive to diagnose.
  //
  // In the steady state this never changes, so it rebuilds nothing and the
  // connection pool is still shared across requests.
  const roleArn = oidcRoleArn()

  if (!objects || builtFor !== roleArn) {
    const config = readUserStorageConfig()

    objects = createS3UserObjectStore({
      config,
      client: createClient(config, roleArn),
    })
    builtFor = roleArn

    // The facades close over the client, so a rebuilt client must invalidate
    // them too — otherwise a role change would swap the credentials underneath
    // and leave the facades holding the old ones. **Every facade above needs a
    // line here**; one left out is a store that keeps assuming the previous
    // role for the life of the instance, and nothing anywhere would say so.
    resumes = undefined
    coverLetters = undefined
    tailoredResumes = undefined
  }

  return objects
}

/**
 * The role to assume on Vercel, or `undefined` anywhere else.
 *
 * ⚠️ **Do not gate this on `VERCEL_OIDC_TOKEN`.** That variable is not how the
 * token reaches a deployed function, and reading it here is what made every
 * upload fail with `Could not load credentials from any providers` — a message
 * that names no role, so it looks like a missing IAM attachment rather than a
 * branch that was never taken. `@vercel/oidc` resolves the token as
 *
 *     getContext().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN
 *
 * — a **per-request header**, with the environment variable only as a fallback
 * for `vercel env pull` locally. On a real deployment nothing sets it, so a
 * gate on it is always false, `createClient` takes its no-credentials branch,
 * and STS is never called at all. That last part is the tell: a trust-policy or
 * audience mismatch still produces a CloudTrail event, and this produces none.
 *
 * `AWS_ROLE_ARN` is the right signal because it is the one that says *assume a
 * role*, and it is set only where that is wanted. It is safe at build time
 * despite `VERCEL=1` being set then too: `awsCredentialsProvider` returns a
 * lazy provider that resolves nothing until the SDK first asks, and nothing in
 * this module runs during `next build` anyway.
 *
 * It stays a function, and `getResumeStore` still calls it on every request,
 * for the reason given there — the answer must not be frozen at whichever
 * moment the first request happened to arrive.
 */
function oidcRoleArn(): string | undefined {
  return process.env.AWS_ROLE_ARN
}

/**
 * On Vercel, credentials come from an OIDC token exchanged for a role; anywhere
 * else they come from the SDK's own default chain.
 *
 * Three things here are non-obvious enough to be worth stating, because each
 * one looks like a simplification waiting to happen:
 *
 * 1. **Memoize the client, not the credentials.** `awsCredentialsProvider`
 *    returns a provider *function* that the SDK calls again as expiry
 *    approaches, and each call reads the current invocation's token. So one
 *    long-lived client is correct and does not staple a expiring credential to
 *    the instance. If `ExpiredToken` ever does appear, stop memoizing the
 *    client — never reach for a static access key.
 *
 *    Note the limit of that: memoizing the client is fine, memoizing *which
 *    branch below was taken* is not. See `getResumeStore`, which re-reads the
 *    environment on every call for exactly that reason and passes the answer
 *    in, rather than letting this function decide once and for all.
 *
 * 2. **Branch on `AWS_ROLE_ARN`, and on nothing else.** Neither `VERCEL` nor
 *    `VERCEL_OIDC_TOKEN` belongs in that test — the first is set during builds
 *    as well as at runtime, and the second is never set on a deployment at all,
 *    because the token is a per-request header. See `oidcRoleArn`, which is
 *    where that mistake was made and is worth reading before changing this.
 *
 * 3. **`AWS_ROLE_ARN` collides with the SDK's own `fromTokenFile` provider,**
 *    which reads the same variable. It never fires here, because it also
 *    requires `AWS_WEB_IDENTITY_TOKEN_FILE` and Vercel does not set one — but
 *    that is a coincidence of two providers' conventions rather than a
 *    guarantee, so the explicit branch below is what actually decides.
 *
 * Locally (`next dev`, not `vercel dev`) there is no token, so this falls to
 * the default chain — `AWS_PROFILE` or an SSO session — which is exactly what
 * `readUserStorageConfig` documents. Note that a local run therefore writes to
 * whatever `USER_STORAGE_ENVIRONMENT` says, and there is only one environment.
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
