/**
 * Durable per-user object storage — generated briefs, uploaded resumes.
 *
 * Compose it once, at the composition root:
 *
 * ```ts
 * const objects = createS3UserObjectStore()
 * const briefs = createBriefStore(objects)
 * const resumes = createResumeStore(objects)
 * ```
 *
 * Everything downstream should take a `BriefStore` or `ResumeStore` as a
 * parameter. That is what keeps the AWS SDK confined to one module.
 *
 * Individual modules are importable directly — `@workspace/user-storage/keys`
 * gets the key helpers without pulling in the SDK at all.
 */
export {
  createS3UserObjectStore,
  type CreateS3UserObjectStoreOptions,
} from "./s3-user-object-store.js"

export type {
  FetchedObject,
  NewObject,
  ObjectRef,
  StoredObject,
  UserObjectStore,
} from "./user-object-store.js"

export {
  createBriefStore,
  type BriefRef,
  type BriefStore,
  type NewBrief,
  type StoredBrief,
} from "./brief-store.js"

export {
  acceptedResumeExtensions,
  createResumeStore,
  type NewResume,
  type ResumeRef,
  type ResumeStore,
  type StoredResume,
} from "./resume-store.js"

export { readUserStorageConfig, type UserStorageConfig } from "./config.js"

export {
  InvalidObjectKeyError,
  isUserStorageError,
  ObjectNotFoundError,
  ObjectOwnershipError,
  StorageUnavailableError,
  UserStorageError,
  type UserStorageErrorCode,
} from "./errors.js"

export {
  buildObjectKey,
  dateSegments,
  kindPrefix,
  parseObjectKey,
  toGeneratedOn,
  userPrefix,
  type ObjectKeyParts,
} from "./keys.js"

export {
  contentTypeFor,
  extensionsFor,
  isObjectKind,
  OBJECT_KIND_NAMES,
  OBJECT_KINDS,
  type ObjectKind,
} from "./kinds.js"
