/** Everything the S3 store needs to reach a bucket. */
export interface UserStorageConfig {
  /** The bucket holding every environment's user data. */
  bucketName: string
  /** Region the bucket lives in. */
  region: string
  /**
   * Deployment environment, the leading key segment. Read from configuration
   * rather than inferred, so a misconfigured worker fails on a missing
   * variable instead of quietly writing production data under `dev/`.
   */
  environment: string
}

/**
 * Read the storage configuration out of the environment.
 *
 * A function rather than a module-level constant, for the same reason
 * `getOpenAIApiKey` in `@workspace/agents-core` is: importing this package must
 * never throw. Builds, typechecks, and consumers that only want the key
 * helpers or the error types have no bucket to point at, and should not need
 * one.
 *
 * Credentials are deliberately absent. The AWS SDK resolves those itself
 * through the default provider chain — the Lambda execution role in
 * production, `AWS_PROFILE` or SSO locally — so there is no code path here
 * that could accept a hard-coded key.
 */
export function readUserStorageConfig(
  env: NodeJS.ProcessEnv = process.env
): UserStorageConfig {
  return {
    bucketName: required(env, "USER_STORAGE_BUCKET_NAME"),
    // AWS_REGION is what Lambda sets for you; AWS_DEFAULT_REGION is the CLI
    // and SDK convention that a local shell is more likely to have.
    region: required(env, "AWS_REGION", "AWS_DEFAULT_REGION"),
    environment: required(env, "USER_STORAGE_ENVIRONMENT"),
  }
}

function required(
  env: NodeJS.ProcessEnv,
  ...names: [string, ...string[]]
): string {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }

  return fail(names)
}

function fail(names: readonly string[]): never {
  const [primary] = names
  const alternatives = names.slice(1)

  throw new Error(
    `${primary} is not set${alternatives.length > 0 ? ` (nor ${alternatives.join(" or ")})` : ""}. ` +
      "User storage needs USER_STORAGE_BUCKET_NAME, AWS_REGION and USER_STORAGE_ENVIRONMENT; " +
      "credentials come from the AWS default provider chain and are never read from here."
  )
}
