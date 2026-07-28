import type { ObjectKeyParts } from "./keys.js"
import type { ObjectKind } from "./kinds.js"

/**
 * Everything needed to address one stored object.
 *
 * `environment` is absent on purpose: it is deployment configuration, not
 * per-object data, so the store supplies it from its own config. A caller
 * therefore cannot reach into another environment's data, however it is
 * called — which is the same boundary the IAM policy draws.
 *
 * `userId` is likewise not an optional convenience. It is what the key is
 * built from and what the stored object is checked against, so a caller cannot
 * ask for an object without saying who is asking.
 */
export interface ObjectRef {
  userId: string
  kind: ObjectKind
  /** The kind-specific key tail. */
  segments: string[]
  /** Dot-prefixed, and on the kind's allowlist. */
  extension: string
}

/** An object on its way in. */
export interface NewObject extends ObjectRef {
  /**
   * The bytes.
   *
   * A `string` is encoded as UTF-8; bytes are stored verbatim. Both are
   * accepted because the two kinds genuinely differ — a brief is text this
   * process just produced, a resume is an opaque upload that must survive
   * byte-for-byte.
   *
   * Note what is *not* here: a content type. That is derived from the
   * extension against the kind's allowlist, because a caller-supplied media
   * type is a caller-supplied claim.
   */
  body: string | Uint8Array

  /** Extra user-metadata to store alongside. Values must be ASCII. */
  metadata?: Record<string, string>
}

/** An object that exists in the store. */
export interface StoredObject extends ObjectKeyParts {
  /** The object key, for logging or handing to another component. */
  key: string
  /** The media type it was stored with. */
  contentType: string
  /** Size in bytes. */
  size: number
  /** When it was written. */
  storedAt: Date
  /** Whatever custom metadata was supplied at write time. */
  metadata: Record<string, string>
}

/** A stored object together with its bytes. */
export interface FetchedObject extends StoredObject {
  body: Uint8Array
  /** The body decoded as UTF-8. Meaningless for a binary kind — use `body`. */
  text(): string
}

/**
 * Durable per-user object storage.
 *
 * Deliberately says nothing about S3, buckets, or commands. That is the point:
 * callers depend on this and nothing else, so the backend can be swapped,
 * faked in a test, or pointed at a local directory without a single caller
 * changing. `createS3UserObjectStore` is the only implementation today and the
 * only module in this package that imports the AWS SDK.
 *
 * This is the generic core. Most code should prefer the narrower facades —
 * `createBriefStore` and `createResumeStore` — which know their kind's key
 * shape and file types so a call site does not have to restate them.
 *
 * Every method rejects with a `UserStorageError` — never a raw SDK error.
 */
export interface UserObjectStore {
  /** Write an object, superseding anything already at the same address. */
  put(object: NewObject): Promise<StoredObject>

  /**
   * Read an object, including its bytes.
   *
   * @throws {import("./errors.js").ObjectNotFoundError} if nothing is stored there.
   * @throws {import("./errors.js").ObjectOwnershipError} if it belongs to another user.
   */
  get(ref: ObjectRef): Promise<FetchedObject>

  /**
   * Read an object's metadata without transferring its bytes.
   *
   * Worth having separately once uploads can be megabytes: an existence or
   * ownership check should not pull a whole PDF across the wire.
   */
  head(ref: ObjectRef): Promise<StoredObject>

  /**
   * Remove an object.
   *
   * On a versioned bucket this hides it behind a delete marker rather than
   * destroying it; prior versions remain until the lifecycle rule expires
   * them.
   *
   * @throws {import("./errors.js").ObjectNotFoundError} if nothing is stored there.
   * @throws {import("./errors.js").ObjectOwnershipError} if it belongs to another user.
   */
  delete(ref: ObjectRef): Promise<void>

  /** Every object of one kind belonging to one user, oldest key first. */
  list(userId: string, kind: ObjectKind): Promise<StoredObject[]>
}
