import { S3Client } from "@aws-sdk/client-s3"
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider"
import {
  createResumeStore,
  createS3UserObjectStore,
  readUserStorageConfig,
  type ResumeStore,
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
let resumes: ResumeStore | undefined

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

export function getResumeStore(): ResumeStore {
  // ⚠️ **The credential source is recomputed every call; only the client is
  // memoized.**
  //
  // `createClient` decides between OIDC and the SDK's default chain by reading
  // the environment. Deciding that once, at whatever moment the first request
  // happened to arrive, means an instance that came up before
  // `VERCEL_OIDC_TOKEN` was injected is pinned to the default chain for its
  // whole life — and every upload it serves fails on absent credentials, which
  // `DEPLOYING.md` has to warn surfaces as nothing more specific than "Document
  // storage is unavailable". Cheap to re-read a string; expensive to diagnose.
  //
  // In the steady state this never changes, so it rebuilds nothing and the
  // connection pool is still shared across requests.
  const roleArn = oidcRoleArn()

  if (!resumes || builtFor !== roleArn) {
    const config = readUserStorageConfig()

    resumes = createResumeStore(
      createS3UserObjectStore({ config, client: createClient(config, roleArn) })
    )
    builtFor = roleArn
  }

  return resumes
}

/** The role to assume on Vercel, or `undefined` anywhere else. */
function oidcRoleArn(): string | undefined {
  return process.env.VERCEL_OIDC_TOKEN ? process.env.AWS_ROLE_ARN : undefined
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
 * 2. **Branch on `VERCEL_OIDC_TOKEN`, not `VERCEL`.** `VERCEL=1` is set during
 *    builds too, where no token exists, so branching on it would take this path
 *    at build time and fail resolving a token that is not there.
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
