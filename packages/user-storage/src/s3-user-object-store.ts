import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"

import { readUserStorageConfig, type UserStorageConfig } from "./config.ts"
import {
  InvalidObjectKeyError,
  ObjectNotFoundError,
  ObjectOwnershipError,
  StorageUnavailableError,
} from "./errors.ts"
import {
  buildObjectKey,
  kindPrefix,
  parseObjectKey,
  type ObjectKeyParts,
} from "./keys.ts"
import { contentTypeFor, dispositionFor, type ObjectKind } from "./kinds.ts"
import type {
  FetchedObject,
  NewObject,
  ObjectRef,
  StoredObject,
  UserObjectStore,
} from "./user-object-store.ts"

/**
 * Reserved user-metadata keys. S3 lowercases metadata names in transit, so
 * these are written lowercase to begin with and read back by the same
 * constant — the round trip is only stable if both ends agree, and a literal
 * typed twice eventually will not.
 */
const METADATA = {
  userId: "user-id",
  kind: "kind",
  environment: "environment",
} as const

const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set(
  Object.values(METADATA)
)

/**
 * The tag every object carries.
 *
 * Not decoration, and not redundant with the key. S3 lifecycle filters are
 * literal prefixes with no wildcard support, so with `kind` sitting below
 * `userId` in the key there is no prefix that means "every user's briefs".
 * Lifecycle rules therefore filter on this tag instead — it is the only reason
 * briefs and resumes can have different retention at all.
 */
const KIND_TAG = "kind"

export interface CreateS3UserObjectStoreOptions {
  /** Defaults to {@link readUserStorageConfig}, i.e. the environment. */
  config?: UserStorageConfig
  /**
   * Defaults to a client built from `config.region`.
   *
   * Supplying one is how a test substitutes a fake, and how a caller that
   * already maintains a client avoids a second connection pool. Note what is
   * *not* here: any way to pass credentials. The SDK resolves those through
   * its default provider chain, so there is no code path through this package
   * that can carry a hard-coded key.
   */
  client?: S3Client
}

/**
 * The S3-backed {@link UserObjectStore}.
 *
 * A factory rather than a class, matching the `createX()` convention the agent
 * packages use, and for the same reason: constructing it reads configuration,
 * so a module-level instance would move that failure to import time and break
 * any consumer that merely imports the module.
 */
export function createS3UserObjectStore(
  options: CreateS3UserObjectStoreOptions = {}
): UserObjectStore {
  const config = options.config ?? readUserStorageConfig()
  const client = options.client ?? new S3Client({ region: config.region })
  const { bucketName, environment } = config

  const keyFor = (ref: ObjectRef): string =>
    buildObjectKey({ ...ref, environment })

  return {
    async put(object: NewObject): Promise<StoredObject> {
      const key = keyFor(object)
      const parts = parseObjectKey(key)
      const contentType = requireContentType(object.kind, parts.extension)
      const metadata = assertCustomMetadata(object.metadata)

      // Encode up front rather than handing S3 a string. It pins the encoding
      // to UTF-8 explicitly instead of relying on the SDK's default, and it
      // gives a byte-accurate Content-Length for a body whose character count
      // and byte count differ the moment it contains an em dash. A Uint8Array
      // passes through untouched, which is what an uploaded PDF requires.
      const body =
        typeof object.body === "string"
          ? Buffer.from(object.body, "utf8")
          : Buffer.from(object.body)

      const storedAt = new Date()

      await guard(key, () =>
        client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: body.byteLength,
            ContentDisposition: dispositionFor(object.kind),
            // The bucket's default encryption already covers this. Stating it
            // anyway means a bucket that somehow lost its default still stores
            // these encrypted, and it keeps the request compatible with a
            // policy that requires the header.
            ServerSideEncryption: "AES256",
            Tagging: `${KIND_TAG}=${object.kind}`,
            Metadata: {
              ...metadata,
              [METADATA.userId]: object.userId,
              [METADATA.kind]: object.kind,
              [METADATA.environment]: environment,
            },
          })
        )
      )

      return {
        ...parts,
        key,
        contentType,
        size: body.byteLength,
        storedAt,
        metadata,
      }
    },

    async get(ref: ObjectRef): Promise<FetchedObject> {
      const key = keyFor(ref)

      const output = await guard(key, () =>
        client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))
      )

      assertOwnedBy(key, ref.userId, output.Metadata)

      if (!output.Body) {
        throw new StorageUnavailableError(`S3 returned no body for "${key}".`)
      }

      // The SDK's own transform. Doing this by hand — collecting chunks and
      // concatenating — is where a multi-byte character straddling a chunk
      // boundary gets corrupted, and where a binary body quietly acquires
      // replacement characters.
      const bytes = await output.Body.transformToByteArray()

      return {
        ...describe(key, output.Metadata, output.ContentType, bytes.byteLength),
        storedAt: output.LastModified ?? new Date(0),
        body: bytes,
        text: () => Buffer.from(bytes).toString("utf8"),
      }
    },

    async head(ref: ObjectRef): Promise<StoredObject> {
      const key = keyFor(ref)

      const output = await guard(key, () =>
        client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }))
      )

      assertOwnedBy(key, ref.userId, output.Metadata)

      return {
        ...describe(
          key,
          output.Metadata,
          output.ContentType,
          output.ContentLength ?? 0
        ),
        storedAt: output.LastModified ?? new Date(0),
      }
    },

    async delete(ref: ObjectRef): Promise<void> {
      const key = keyFor(ref)

      // Head before delete, for two reasons that both matter. DeleteObject
      // succeeds on a key that was never there, so without this a caller
      // deleting a typo would be told it worked. And the ownership check needs
      // metadata, which only a read can supply — deleting first and checking
      // after would check something already gone.
      const output = await guard(key, () =>
        client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }))
      )

      assertOwnedBy(key, ref.userId, output.Metadata)

      await guard(key, () =>
        client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
      )
    },

    async list(userId: string, kind: ObjectKind): Promise<StoredObject[]> {
      const prefix = kindPrefix(environment, userId, kind)
      const found: StoredObject[] = []
      let continuationToken: string | undefined

      // Paginated by hand rather than fetched once. S3 caps a page at 1000
      // keys and silently truncates without the loop, which would show a user
      // a partial list that looks complete.
      do {
        const page = await guard(prefix, () =>
          client.send(
            new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: prefix,
              ContinuationToken: continuationToken,
            })
          )
        )

        for (const item of page.Contents ?? []) {
          if (!item.Key) continue

          // A key that does not parse is not this package's — skip it rather
          // than failing the whole listing over one stray object.
          const parts = tryParse(item.Key)
          if (!parts) continue

          found.push({
            ...parts,
            key: item.Key,
            contentType: contentTypeFor(parts.kind, parts.extension) ?? "",
            size: item.Size ?? 0,
            storedAt: item.LastModified ?? new Date(0),
            metadata: {},
          })
        }

        continuationToken = page.IsTruncated
          ? page.NextContinuationToken
          : undefined
      } while (continuationToken)

      return found
    },
  }
}

function tryParse(key: string): ObjectKeyParts | undefined {
  try {
    return parseObjectKey(key)
  } catch {
    return undefined
  }
}

function requireContentType(kind: ObjectKind, extension: string): string {
  const contentType = contentTypeFor(kind, extension)

  if (!contentType) {
    throw new InvalidObjectKeyError(
      `"${extension}" is not an accepted file type for ${kind}.`
    )
  }

  return contentType
}

/**
 * Custom metadata must not overwrite the fields ownership depends on.
 *
 * Without this, a caller passing `{ "user-id": "someone-else" }` would write an
 * object that passes its own ownership check — the check would be reading a
 * value the attacker supplied.
 */
function assertCustomMetadata(
  metadata: Record<string, string> | undefined
): Record<string, string> {
  if (!metadata) return {}

  for (const key of Object.keys(metadata)) {
    if (RESERVED_METADATA_KEYS.has(key.toLowerCase())) {
      throw new InvalidObjectKeyError(
        `Metadata key "${key}" is reserved and cannot be set by a caller.`
      )
    }
  }

  return metadata
}

/**
 * The second ownership check.
 *
 * The first is structural — the key is derived from the caller's own `userId`,
 * so there is no way to *name* another user's object. This one catches what
 * survives that: an object written by an older or buggier writer, a key reused
 * after a user was deleted, or metadata and key disagreeing at all. Cheap, and
 * it is the difference between a bug and a disclosure.
 */
function assertOwnedBy(
  key: string,
  expectedUserId: string,
  metadata: Record<string, string> | undefined
): void {
  const actual = metadata?.[METADATA.userId]

  if (actual !== expectedUserId) {
    throw new ObjectOwnershipError(key, expectedUserId, actual)
  }
}

function describe(
  key: string,
  metadata: Record<string, string> | undefined,
  contentType: string | undefined,
  size: number
): StoredObject {
  const parts = parseObjectKey(key)

  return {
    ...parts,
    key,
    contentType:
      contentType ?? contentTypeFor(parts.kind, parts.extension) ?? "",
    size,
    storedAt: new Date(0),
    metadata: custom(metadata),
  }
}

/** Whatever the caller supplied, without the fields this package reserves. */
function custom(
  metadata: Record<string, string> | undefined
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => !RESERVED_METADATA_KEYS.has(key.toLowerCase())
    )
  )
}

/**
 * Run one S3 call, translating every SDK failure into this package's errors.
 *
 * Takes a thunk rather than a command so that `client.send` is resolved at the
 * call site, where its overloads still know which output type goes with which
 * command. A wrapper that accepted the command instead would collapse all of
 * them to the union and hand back `unknown`.
 *
 * The seam exists so no caller ever catches an `S3ServiceException`. A missing
 * object and an unreachable bucket are genuinely different problems — one is
 * the caller's, one is the platform's — and that is the only distinction drawn
 * here. `AccessDenied` lands with the platform faults deliberately: from the
 * caller's point of view a policy that does not permit the read is the store
 * being unavailable, not the object being absent.
 */
async function guard<Output>(
  key: string,
  run: () => Promise<Output>
): Promise<Output> {
  try {
    return await run()
  } catch (error) {
    if (isNotFound(error)) {
      throw new ObjectNotFoundError(key, { cause: error })
    }

    throw new StorageUnavailableError(
      `S3 request failed for "${key}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}

/**
 * A missing *object*, as distinct from a missing bucket.
 *
 * GetObject reports a missing key as `NoSuchKey`; HeadObject has no response
 * body to put an error code in and reports the same condition as a bare 404
 * named `NotFound`. Both mean the object is not there.
 *
 * `NoSuchBucket` is also a 404 and must not land here. A bucket that does not
 * exist is a misconfigured `USER_STORAGE_BUCKET_NAME` — the store being
 * unavailable — and reporting it as a missing object would send whoever is
 * debugging it looking for the wrong thing entirely.
 */
const NOT_A_MISSING_OBJECT = new Set(["NoSuchBucket", "PermanentRedirect"])

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false

  const { name } = error as { name?: unknown }
  if (typeof name === "string" && NOT_A_MISSING_OBJECT.has(name)) return false

  if (name === "NoSuchKey" || name === "NotFound") return true

  const { $metadata } = error as { $metadata?: { httpStatusCode?: number } }
  return $metadata?.httpStatusCode === 404
}
