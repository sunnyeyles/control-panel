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
} from "./s3-user-object-store.ts"

export type {
  FetchedObject,
  NewObject,
  ObjectRef,
  StoredObject,
  UserObjectStore,
} from "./user-object-store.ts"

export {
  createBriefStore,
  type BriefRef,
  type BriefStore,
  type NewBrief,
  type StoredBrief,
} from "./brief-store.ts"

export {
  acceptedResumeExtensions,
  createResumeStore,
  DOCUMENT_TYPES,
  isDocumentType,
  type DocumentType,
  type NewResume,
  type ResumeRef,
  type ResumeStore,
  type StoredResume,
} from "./resume-store.ts"

export { readUserStorageConfig, type UserStorageConfig } from "./config.ts"

export {
  InvalidObjectKeyError,
  isUserStorageError,
  ObjectNotFoundError,
  ObjectOwnershipError,
  StorageUnavailableError,
  UserStorageError,
  type UserStorageErrorCode,
} from "./errors.ts"

export {
  buildObjectKey,
  dateSegments,
  isObjectKeySegment,
  kindPrefix,
  parseObjectKey,
  toGeneratedOn,
  userPrefix,
  type ObjectKeyParts,
} from "./keys.ts"

export {
  contentTypeFor,
  extensionsFor,
  isObjectKind,
  OBJECT_KINDS,
  type ObjectKind,
} from "./kinds.ts"
