import { MemoryObjectStore } from "@workspace/user-storage/memory-object-store"

import { ENVIRONMENT } from "./identities"

/**
 * The dashboard's name for the shared in-memory `UserObjectStore`.
 *
 * `@workspace/user-storage/memory-object-store` owns the implementation —
 * real `buildObjectKey`, real `ObjectNotFoundError` — and states why both
 * matter. What this binds is the dashboard's conventions: the fixture
 * environment, a markdown content type, and each suite's own write instant.
 */
export class MemoryObjects extends MemoryObjectStore {
  /**
   * @param storedAt what every object reports as its write time. Each suite
   * picks its own instant; nothing here has an opinion about which.
   */
  constructor(storedAt: Date) {
    super({
      environment: ENVIRONMENT,
      storedAt,
      contentType: "text/markdown; charset=utf-8",
    })
  }
}
