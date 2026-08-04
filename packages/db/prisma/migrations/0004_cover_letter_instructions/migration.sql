-- How a user wants their cover letters written, one row per user at most.
--
-- Its own table rather than columns on `users`: that table is the platform
-- identity `jobs.user_id` references and the `user_id` segment of every object
-- key, and it deliberately carries nothing else.
--
-- Both text columns default to '' rather than being nullable, so "nothing set"
-- has exactly one representation in a column. Two columns rather than one
-- because the system prompt built from them fences each differently: the rules
-- are followed, the example letter is imitated and never mined for facts, and a
-- single column could not express that difference.
--
-- Forward-only, like every migration here.

-- CreateTable
CREATE TABLE "cover_letter_instructions" (
    "user_id" UUID NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "example_letter" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cover_letter_instructions_pkey" PRIMARY KEY ("user_id")
);

-- The one cascade in this schema, against the restrict-everywhere rule of
-- `0001_init`. A settings row is a preference with no independent existence,
-- not a record that something happened, so there is no provenance to erase —
-- and RESTRICT here would make a user undeletable for the sake of one.
ALTER TABLE "cover_letter_instructions"
  ADD CONSTRAINT "cover_letter_instructions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
