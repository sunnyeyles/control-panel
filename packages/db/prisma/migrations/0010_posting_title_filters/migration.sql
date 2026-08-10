-- Words that rule a Posting out by its title, and the column that makes them
-- answerable in SQL.
--
-- Every other search criterion a user has is inclusive — titles, locations and
-- keywords each widen a search. This is the first subtractive one, and unlike
-- `jobs.config -> 'exclude'`, which is rendered into the scout's brief and which
-- the model is free to disregard, it is enforced: the worker drops a matching
-- posting before the brief is written, and the dashboard hides one already
-- collected.
--
-- Forward-only, like every migration here.

-- Per user, not per job. One list, edited in one place, applying to every
-- briefing the account has and to the Postings table besides — so it is a
-- settings row and takes the shape of `cover_letter_instructions`, cascade
-- included: a preference with no independent existence is not a record that
-- something happened, and `RESTRICT` would make a user undeletable for the sake
-- of one.
CREATE TABLE posting_filters (
  user_id          uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  title_exclusions text[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),

  -- Generous, and there only so one paste cannot write an unbounded row. The
  -- same bound is `MAX_TITLE_EXCLUSIONS` in `@workspace/job-search`, which is
  -- what produces the message the user actually reads; this is the backstop for
  -- every path that does not go through a form.
  CONSTRAINT posting_filters_title_exclusions_check
    CHECK (cardinality(title_exclusions) <= 50)
);

-- The title as the filter compares it.
--
-- ⚠️ **This is half of a rule stated twice**, exactly as `0006`'s date regex is
-- half of `parsePostedAt()`. The other half is `normalizeTitle()` in
-- `@workspace/job-search`, which the worker uses to drop a posting on the way
-- in; this is what the dashboard's paginated query filters on, and the two must
-- produce the same string for the same title.
--
-- Lowercased, every run of non-alphanumerics flattened to a single space, and a
-- space at each end:
--
--     'Senior/Staff Engineer (Remote)'  ->  ' senior staff engineer remote '
--
-- **The padding is the whole trick.** It turns whole-word matching into a plain
-- substring test — ` senior ` is inside that string and is not inside
-- ' seniority partners ' — so the query needs no word-boundary support and stays
-- an ordinary `LIKE '%…%'` that Prisma can express. It also makes a multi-word
-- term work for free: ` tech lead ` matches "Tech Lead" and not "Lead Tech".
--
-- The `btrim` is what makes the two halves produce the *same string* rather
-- than merely the same answer: without it a title with a leading space keeps a
-- double space at the front, which matches identically and would still be a
-- gratuitous difference for anyone comparing the two implementations.
--
-- `[:alnum:]` rather than `a-z0-9` deliberately: the POSIX class is locale-aware
-- and keeps accented letters whole, which is what lets the TypeScript half spell
-- it `\p{L}\p{N}` and mean the same thing. 'Développeur' must not become two
-- words on one side of the seam and one on the other.
--
-- `GENERATED ALWAYS … STORED` rather than a column the write path maintains, so
-- it cannot drift from `title` however a row is written — and both posting
-- inserts are raw SQL with explicit column lists, so neither has to learn about
-- it. Every row already stored is backfilled by this statement.
--
-- No index. `LIKE '%…%'` cannot use a btree, `WHERE user_id = …` already narrows
-- to one person's rows, and a `pg_trgm` GIN index is a lot of machinery for a
-- table this size. If that stops being true the index is additive.
ALTER TABLE postings
  ADD COLUMN title_normalized text
  GENERATED ALWAYS AS (
    ' ' || btrim(regexp_replace(lower(title), '[^[:alnum:]]+', ' ', 'g')) || ' '
  ) STORED;
