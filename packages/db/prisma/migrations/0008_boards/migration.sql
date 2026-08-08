-- The whiteboard a user is working on. One row per user, at most.
--
-- `user_id` is the primary key rather than a unique column beside a surrogate
-- id, which is what makes "one board per user" a fact about the table instead
-- of a rule the application remembers to follow. There is exactly one board
-- today; giving a user several is then a real migration — a new key, and a
-- decision about which one loads — rather than a constraint quietly dropped.
--
-- `snapshot` is opaque, like `runs.findings` and `jobs.config`. It holds a
-- tldraw store snapshot, whose shape belongs to tldraw and changes when tldraw
-- migrates it; nothing on this side reads inside it. Columns per shape would be
-- a second copy of a format that already has an owner, and it would be the copy
-- that goes stale.
--
-- Forward-only, like every migration here.

-- CreateTable
CREATE TABLE "boards" (
    "user_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("user_id")
);

-- Cascades, like `cover_letter_instructions` and against the restrict-everywhere
-- rule of `0001_init`. A board is work in progress rather than a record that
-- something happened, so there is no provenance to erase, and RESTRICT would
-- make a user undeletable for the sake of a drawing.
ALTER TABLE "boards"
  ADD CONSTRAINT "boards_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
