-- One row per Document a user has uploaded — the metadata that used to live on
-- the S3 object itself.
--
-- A Document has always been an object under `{environment}/{userId}/resumes/`
-- with its filename and its Document Type stored as S3 **user metadata**. That
-- is a set of HTTP headers, and three things follow from it. `ListObjectsV2`
-- does not return user metadata, so listing a user's documents cost one
-- `HeadObject` per document on every render of `/documents`, of `/settings`,
-- and of every cover-letter and tailored-resume draft. A header value must be
-- printable US-ASCII, so an em dash in a filename was stripped on the way in
-- and never came back. And metadata is fixed at write time — changing it needs
-- a copy onto itself, which `UserObjectStore` deliberately does not expose — so
-- a mislabelled document could only be corrected by uploading it again.
--
-- This table answers all three. S3 keeps the bytes; the row is what the
-- application reads.
--
-- Forward-only, like every migration here.
--
-- **The table is created empty, and no SQL backfill is possible.** The values
-- being moved are in S3, not in Postgres, so nothing here can reach them. Every
-- object keeps its metadata and none is deleted, which is what would let a
-- script walking each user's `resumes` prefix insert the rows later — but until
-- something does, a document uploaded before this migration has no row and does
-- not appear in the list.

-- CreateTable
CREATE TABLE "documents" (
    -- Supplied by the caller and deliberately **not** defaulted, unlike every
    -- other id in this schema. This uuid is the S3 key segment in
    -- `{environment}/{user_id}/resumes/{id}{extension}` before it is a primary
    -- key: the object has to be written before the row, so the id must exist
    -- first. A `DEFAULT gen_random_uuid()` that quietly fired would mint a row
    -- addressing an object that is not there.
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    -- The other half of the key, dot-prefixed and lowercase.
    "extension" TEXT NOT NULL,
    -- What the user called the file. Here rather than in S3 user metadata,
    -- which is an HTTP header and carries printable ASCII and nothing else.
    "filename" TEXT NOT NULL,
    -- text + CHECK rather than a Postgres enum, as `runs.status` and
    -- `postings.status` are. Along with `filename`, one of the two columns in
    -- this schema a *person* writes.
    "doc_type" TEXT NOT NULL DEFAULT 'other',
    "byte_size" INTEGER NOT NULL,
    -- When the upload landed, as the application saw it. Not S3's
    -- `LastModified`, which is the object's write time and moves if the object
    -- is ever rewritten.
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id"),
    -- The six selectable Document Types. `other` is not filler: without it a
    -- document that is none of the other five has to be mislabelled as one of
    -- them, and a label nobody trusts is worse than no label.
    CONSTRAINT "documents_doc_type_check"
      CHECK ("doc_type" IN ('resume', 'cover-letter', 'portfolio',
                            'reference', 'certification', 'other')),
    -- The shape `EXTENSION_SOURCE` in `@workspace/user-storage/keys` accepts.
    -- Not a duplicate of the validation there, for the reason
    -- `postings_posting_id_check` gives: that rule guards untrusted input and
    -- stays the only copy of that. This one says the database must not hold a
    -- value that cannot be part of an object key.
    CONSTRAINT "documents_extension_check"
      CHECK ("extension" ~ '^\.[a-z0-9]{1,16}$'),
    -- A document with no name cannot be rendered or downloaded meaningfully,
    -- and the upper bound is the same order as the metadata budget the old
    -- header had to fit inside.
    CONSTRAINT "documents_filename_check"
      CHECK (char_length("filename") BETWEEN 1 AND 512),
    CONSTRAINT "documents_byte_size_check"
      CHECK ("byte_size" >= 0)
);

-- Restrict, never cascade, per `0001_init`. A Document row is a pointer at
-- bytes in a bucket, so deleting the user out from under it would leave objects
-- nothing names. `cover_letter_instructions` remains the single exception in
-- this schema, and it earns it by recording no provenance at all.
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The only listing there is: one user's documents, newest first. Tie-broken on
-- `id` so two uploads sharing a timestamp cannot swap places between renders.
CREATE INDEX "documents_user_uploaded_idx"
  ON "documents" ("user_id", "uploaded_at" DESC, "id" DESC);
