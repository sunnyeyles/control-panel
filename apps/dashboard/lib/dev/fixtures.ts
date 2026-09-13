import type { CurrentUser } from "@/lib/auth/current-user"
import type { Document } from "@workspace/db/types"
/**
 * ⚠️ **Value imports use subpaths, not the barrels.** `current-user.ts` imports
 * `DEV_USER` from here and runs on every request, so the barrels would put
 * `@aws-sdk/client-s3` and `pg` on the production graph for a fixture. Types may
 * stay on the barrel — they are erased.
 */
import { contentTypeFor } from "@workspace/user-storage/kinds"
import type { NewResume } from "@workspace/user-storage"

/**
 * The world `DEV_AUTH_BYPASS=1` renders.
 *
 * Picked to exercise branches, not to look plausible — a fixture where every
 * field is present proves nothing about the optional ones. Dates are fixed so
 * renders are deterministic.
 */

/** Fixed so every id derived from it — S3 keys included — is stable. */
export const DEV_USER_ID = "3f8d1b2a-0000-4000-8000-000000000001"

const SEEDED_AT = new Date("2026-08-01T00:00:00.000Z")

/**
 * The session every request gets under the flag.
 *
 * `userId` is a `users.id`-shaped uuid, never a Neon Auth id — it becomes the
 * `userId` segment of every S3 key, exactly as the real one does.
 */
export const DEV_USER: CurrentUser = {
  status: "ok",
  userId: DEV_USER_ID,
  email: "dev@localhost",
  name: "Dev User",
}

/**
 * ⚠️ **A Document is two fixtures, and they have to agree.**
 *
 * {@link devUploads} is the bytes in the fake bucket, {@link devDocuments} the
 * row in the fake database, and a row's `id` is its object's `resumeId` — the
 * real key relationship, not a fixture convention. Each half alone is a real
 * production state (a row with no object 404s on download, an object with no
 * row is invisible), so the three below are paired.
 */
const DEV_DOCUMENT_IDS = {
  markdownCv: "3f8d1b2a-0000-4000-8000-0000000000c1",
  pdfCv: "3f8d1b2a-0000-4000-8000-0000000000c2",
  referees: "3f8d1b2a-0000-4000-8000-0000000000c3",
} as const

/** Documents as they arrive at `ResumeStore.put()`. */
export function devUploads(): NewResume[] {
  return [
    {
      userId: DEV_USER_ID,
      resumeId: DEV_DOCUMENT_IDS.markdownCv,
      extension: ".md",
      bytes: encode(DEV_CV_MARKDOWN),
      originalFilename: "dev-user-cv.md",
      documentType: "resume",
    },
    {
      userId: DEV_USER_ID,
      resumeId: DEV_DOCUMENT_IDS.pdfCv,
      extension: ".pdf",
      // Not a real PDF; nothing renders its contents.
      bytes: encode("%PDF-1.4 dev fixture, not a real document"),
      originalFilename: "dev-user-cv.pdf",
      documentType: "resume",
    },
    {
      userId: DEV_USER_ID,
      resumeId: DEV_DOCUMENT_IDS.referees,
      extension: ".txt",
      bytes: encode("Referees available on request.\n"),
      originalFilename: "referees.txt",
      documentType: "reference",
    },
  ]
}

/**
 * The rows in `documents` for the objects above — what `/documents` reads.
 *
 * `uploadedAt` is staggered so newest-first is observable. The en dash in the
 * last filename is the character the old S3-metadata storage stripped, so a row
 * showing it intact is the visible half of why this table exists.
 */
export function devDocuments(): Document[] {
  return [
    {
      id: DEV_DOCUMENT_IDS.markdownCv,
      userId: DEV_USER_ID,
      extension: ".md",
      filename: "dev-user-cv.md",
      docType: "resume",
      byteSize: encode(DEV_CV_MARKDOWN).byteLength,
      uploadedAt: SEEDED_AT,
    },
    {
      id: DEV_DOCUMENT_IDS.pdfCv,
      userId: DEV_USER_ID,
      extension: ".pdf",
      filename: "dev-user-cv.pdf",
      docType: "resume",
      byteSize: 40,
      uploadedAt: new Date(SEEDED_AT.getTime() - 86_400_000),
    },
    {
      id: DEV_DOCUMENT_IDS.referees,
      userId: DEV_USER_ID,
      extension: ".txt",
      filename: "referees – 2026.txt",
      docType: "reference",
      byteSize: 31,
      uploadedAt: new Date(SEEDED_AT.getTime() - 172_800_000),
    },
  ]
}

/** The media type the real store would have derived from the extension. */
export function devContentType(kind: "resumes", extension: string): string {
  return contentTypeFor(kind, extension) ?? "application/octet-stream"
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

const DEV_CV_MARKDOWN = `# Dev User

Backend engineer, Sydney. Eight years across logistics and payments.

## Experience

**Senior Engineer, Kestrel Logistics** (2022–present)
Owned the dispatch service — TypeScript, Postgres, AWS. Took its p99 from
1.8s to 240ms by moving the hot path off a synchronous fan-out.

**Engineer, Tessellate** (2018–2022)
Built and ran the billing pipeline. Wrote the reconciliation job that closed
a long-standing class of silent under-charges.

## Skills

TypeScript, Go, Postgres, Terraform, AWS.
`
