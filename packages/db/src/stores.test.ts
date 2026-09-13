import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createPrismaClient,
  deleteDocument,
  DOCUMENT_TYPES,
  ensureUserForAuth,
  findDocument,
  listDocumentsForUser,
  loadBoard,
  recordDocument,
  saveBoard,
  type DocumentType,
  type NewDocument,
  type PrismaClient,
} from "./index.ts"

/**
 * The half of this package that needs Postgres to be Postgres.
 *
 * Everything asserted below is a property of the database rather than of the
 * code — a unique index under concurrency, a CHECK, a foreign key's `RESTRICT`
 * or `CASCADE`. A fake cannot enforce any of them.
 *
 * Skipped when `DATABASE_URL_UNPOOLED` is unset, so `pnpm test` stays runnable
 * with no credentials. In CI a disposable Neon branch supplies it.
 *
 * The direct endpoint, not the pooled one. Deploy uses `prisma migrate deploy`;
 * this suite applies the same SQL into a throwaway schema via `search_path` so
 * it cannot touch data it did not write. Prisma Migrate's emptiness check looks
 * at the whole database, so `migrate deploy` cannot target an isolated schema
 * beside an existing `public`.
 */
const CONNECTION_STRING = process.env.DATABASE_URL_UNPOOLED?.trim()

const SCHEMA = `db_test_${randomUUID().replaceAll("-", "")}`

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

/**
 * Postgres resolves unqualified names through `search_path`, so pointing it at
 * the throwaway schema is what makes the migration SQL — which names no schema
 * — land there.
 */
const describeWithDatabase = CONNECTION_STRING ? describe : describe.skip

describeWithDatabase("against a real database", () => {
  let baseUrl: string
  let admin: pg.Client
  let prisma: PrismaClient
  let userId: string

  beforeAll(async () => {
    baseUrl = CONNECTION_STRING as string

    admin = new pg.Client({ connectionString: baseUrl })
    await admin.connect()
    await admin.query(`create schema "${SCHEMA}"`)

    // Every migration, in the order `migrate deploy` would apply them — the
    // directory names sort into that order and are the only thing that
    // decides it. Reading the directory rather than naming a file is what
    // keeps this suite from testing a schema two migrations old.
    const migrations = join(packageRoot, "prisma/migrations")
    const directories = (await readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    // Pin search_path so unqualified DDL lands in the throwaway schema.
    const migrator = new pg.Client({ connectionString: baseUrl })
    await migrator.connect()
    try {
      await migrator.query(`SET search_path TO "${SCHEMA}"`)

      for (const directory of directories) {
        await migrator.query(
          await readFile(join(migrations, directory, "migration.sql"), "utf8")
        )
      }
    } finally {
      await migrator.end()
    }

    prisma = createPrismaClient({ connectionString: baseUrl, schema: SCHEMA })
    const user = await prisma.user.create({ data: {} })
    userId = user.id
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    await admin?.query(`drop schema if exists "${SCHEMA}" cascade`)
    await admin?.end()
  })

  describe("the auth identity link", () => {
    it("mints one user for an identity it has never seen", async () => {
      const authUserId = `auth_${randomUUID()}`

      const user = await ensureUserForAuth(prisma, authUserId)

      expect(user.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )
      expect(user.id).not.toBe(authUserId)
      expect(
        await prisma.user.findUnique({ where: { id: user.id } })
      ).toBeDefined()
    })

    it("returns the same user on every later request", async () => {
      const authUserId = `auth_${randomUUID()}`

      const first = await ensureUserForAuth(prisma, authUserId)
      const second = await ensureUserForAuth(prisma, authUserId)

      expect(second.id).toBe(first.id)
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime())
    })

    it("mints once for two concurrent first requests", async () => {
      const authUserId = `auth_${randomUUID()}`

      const rival = createPrismaClient({
        connectionString: baseUrl,
        schema: SCHEMA,
      })

      try {
        const [mine, theirs] = await Promise.all([
          ensureUserForAuth(prisma, authUserId),
          ensureUserForAuth(rival, authUserId),
        ])

        expect(theirs.id).toBe(mine.id)

        const { rows } = await admin.query<{ count: string }>(
          `select count(*)::text as count from "${SCHEMA}".users where auth_user_id = $1`,
          [authUserId]
        )
        expect(rows[0]?.count).toBe("1")
      } finally {
        await rival.$disconnect()
      }
    })

    it("keeps unlinked users legal, and there can be many", async () => {
      await prisma.user.create({ data: {} })
      await prisma.user.create({ data: {} })

      const { rows } = await admin.query<{ count: string }>(
        `select count(*)::text as count from "${SCHEMA}".users where auth_user_id is null`
      )
      expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(3)
    })

    it("refuses to point two users at one identity", async () => {
      const authUserId = `auth_${randomUUID()}`
      await ensureUserForAuth(prisma, authUserId)

      const other = await prisma.user.create({ data: {} })

      await expect(
        admin.query(
          `update "${SCHEMA}".users set auth_user_id = $1 where id = $2`,
          [authUserId, other.id]
        )
      ).rejects.toThrow()
    })
  })

  describe("documents", () => {
    let index = 0

    /** A row whose id is a fresh uuid, because the id is not defaulted here. */
    function aDocument(overrides: Partial<NewDocument> = {}): NewDocument {
      index += 1

      return {
        id: randomUUID(),
        userId,
        extension: ".pdf",
        filename: `cv-${index}.pdf`,
        docType: "resume",
        byteSize: 1024,
        ...overrides,
      }
    }

    it("round-trips a document and reads it back by owner", async () => {
      const written = await recordDocument(prisma, aDocument())

      const read = await findDocument(prisma, userId, written.id)

      expect(read).toMatchObject({
        id: written.id,
        userId,
        extension: ".pdf",
        docType: "resume",
        byteSize: 1024,
      })
    })

    it("keeps a filename S3 user metadata could not have carried", async () => {
      // The reason this column exists. A metadata value travels as an HTTP
      // header, so `toMetadataValue` strips it to printable ASCII; `text` does
      // not, which is why the filename moved here and not the other way.
      const written = await recordDocument(
        prisma,
        aDocument({ filename: "Lebenslauf – 2026 ✅.pdf" })
      )

      expect((await findDocument(prisma, userId, written.id))?.filename).toBe(
        "Lebenslauf – 2026 ✅.pdf"
      )
    })

    it("accepts each of the six document types and refuses a seventh", async () => {
      for (const docType of DOCUMENT_TYPES) {
        const written = await recordDocument(prisma, aDocument({ docType }))
        expect((await findDocument(prisma, userId, written.id))?.docType).toBe(
          docType
        )
      }

      // The compiler forbids a seventh, so the cast is what makes this a test
      // of the CHECK rather than of the type.
      const seventh = "diploma" as string as DocumentType

      await expect(
        recordDocument(prisma, aDocument({ docType: seventh }))
      ).rejects.toThrow()
    })

    it("refuses an extension that could not be part of an object key", async () => {
      // `documents_extension_check` mirrors `EXTENSION_SOURCE` in
      // `@workspace/user-storage/keys`. A row holding one of these would
      // address an object nothing could ever have written.
      for (const extension of ["", "pdf", ".PDF", ".p df", "../etc", ".pdf."]) {
        await expect(
          recordDocument(prisma, aDocument({ extension }))
        ).rejects.toThrow()
      }
    })

    it("refuses an empty filename and a negative size", async () => {
      await expect(
        recordDocument(prisma, aDocument({ filename: "" }))
      ).rejects.toThrow()

      await expect(
        recordDocument(prisma, aDocument({ byteSize: -1 }))
      ).rejects.toThrow()
    })

    it("defaults an unspecified type to `other` rather than to NULL", async () => {
      const id = randomUUID()

      await prisma.$executeRaw`
        INSERT INTO documents (id, user_id, extension, filename, byte_size)
        VALUES (${id}::uuid, ${userId}::uuid, '.pdf', 'unlabelled.pdf', 1)
      `

      expect((await findDocument(prisma, userId, id))?.docType).toBe("other")
    })

    it("lists newest first, tie-broken so a row cannot move between reads", async () => {
      const owner = await prisma.user.create({ data: {} })
      const at = (iso: string) => new Date(iso)

      const older = await recordDocument(
        prisma,
        aDocument({ userId: owner.id }),
        at("2026-01-01T00:00:00.000Z")
      )
      const newest = await recordDocument(
        prisma,
        aDocument({ userId: owner.id }),
        at("2026-07-01T00:00:00.000Z")
      )
      const middle = await recordDocument(
        prisma,
        aDocument({ userId: owner.id }),
        at("2026-04-01T00:00:00.000Z")
      )

      const listed = await listDocumentsForUser(prisma, owner.id)

      expect(listed.map((row) => row.id)).toEqual([
        newest.id,
        middle.id,
        older.id,
      ])
    })

    it("does not read or delete another user's document", async () => {
      // ⚠️ The `userId` filter is the *whole* ownership check on both calls —
      // there is nothing underneath it the way `assertOwnedBy` sits under the
      // object store. Dropping it would be invisible without this.
      const stranger = await prisma.user.create({ data: {} })
      const mine = await recordDocument(prisma, aDocument())

      expect(await findDocument(prisma, stranger.id, mine.id)).toBeUndefined()
      expect(await deleteDocument(prisma, stranger.id, mine.id)).toBe(false)
      expect(await findDocument(prisma, userId, mine.id)).toBeDefined()
    })

    it("reports whether a delete found anything, rather than throwing", async () => {
      const written = await recordDocument(prisma, aDocument())

      expect(await deleteDocument(prisma, userId, written.id)).toBe(true)
      // The second call is the ordinary case, not an error: two tabs, one
      // document. `deleteMany` is what makes it an answer instead of a throw.
      expect(await deleteDocument(prisma, userId, written.id)).toBe(false)
      expect(await findDocument(prisma, userId, written.id)).toBeUndefined()
    })

    it("refuses two documents with the same id", async () => {
      // The id is also the S3 key segment, so a duplicate would mean two rows
      // claiming the same object.
      const written = await recordDocument(prisma, aDocument())

      await expect(
        recordDocument(prisma, aDocument({ id: written.id }))
      ).rejects.toThrow()
    })
  })

  describe("boards", () => {
    it("reads nothing for a user who has never drawn one", async () => {
      const fresh = await prisma.user.create({ data: {} })

      expect(await loadBoard(prisma, fresh.id)).toBeUndefined()
    })

    it("round-trips a snapshot unchanged, because it is opaque here", async () => {
      const fresh = await prisma.user.create({ data: {} })
      const snapshot = {
        document: {
          store: { "shape:s1": { x: 0, y: -12.5, nested: [1, null] } },
        },
        session: { currentPageId: "page:page" },
      }

      await saveBoard(prisma, fresh.id, snapshot)

      expect(await loadBoard(prisma, fresh.id)).toEqual(snapshot)
    })

    it("replaces the snapshot whole rather than merging into it", async () => {
      const fresh = await prisma.user.create({ data: {} })

      await saveBoard(prisma, fresh.id, { document: { store: { a: 1 } } })
      await saveBoard(prisma, fresh.id, { document: { store: { b: 2 } } })

      // A board is a picture, not a patch of one — `a` must be gone.
      expect(await loadBoard(prisma, fresh.id)).toEqual({
        document: { store: { b: 2 } },
      })
    })

    it("keeps at most one row per user, which the primary key enforces", async () => {
      const fresh = await prisma.user.create({ data: {} })

      await saveBoard(prisma, fresh.id, { n: 1 })
      await saveBoard(prisma, fresh.id, { n: 2 })

      const { rows } = await admin.query<{ count: string }>(
        `select count(*)::text as count from "${SCHEMA}".boards where user_id = $1`,
        [fresh.id]
      )
      expect(rows[0]?.count).toBe("1")
    })

    it("goes with the user, which is the whole point of the cascade", async () => {
      const doomed = await prisma.user.create({ data: {} })
      await saveBoard(prisma, doomed.id, { n: 1 })

      await admin.query(`delete from "${SCHEMA}".users where id = $1`, [
        doomed.id,
      ])

      expect(await loadBoard(prisma, doomed.id)).toBeUndefined()
    })
  })

  describe("referential integrity", () => {
    it("refuses to delete a user who still owns documents", async () => {
      const owner = await prisma.user.create({ data: {} })
      const document = await recordDocument(prisma, {
        id: randomUUID(),
        userId: owner.id,
        extension: ".pdf",
        filename: "cv.pdf",
        docType: "resume",
        byteSize: 1,
      })

      await expect(
        admin.query(`delete from "${SCHEMA}".users where id = $1`, [owner.id])
      ).rejects.toThrow()

      expect(await findDocument(prisma, owner.id, document.id)).toBeDefined()
    })

    it("refuses a document for a user who does not exist", async () => {
      await expect(
        recordDocument(prisma, {
          id: randomUUID(),
          userId: randomUUID(),
          extension: ".pdf",
          filename: "cv.pdf",
          docType: "resume",
          byteSize: 1,
        })
      ).rejects.toThrow()
    })
  })
})
