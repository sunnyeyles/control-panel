-- A fourth Posting Status: the user has read the advertisement and decided not
-- to apply.
--
-- There was nowhere for that decision to go. A Posting left at `new` is
-- indistinguishable from one nobody has opened, and deleting the row does not
-- settle it either — `recordPostings` upserts on `(user_id, posting_id)`, so
-- the next Run that re-finds the advertisement inserts it again at `new`. The
-- decision has to be a value in this column or it is not durable at all.
--
-- **Who acts differs across the four, and the names only read correctly if you
-- know that.** `applied` and `not-interested` are decisions the user takes
-- about the advertisement; `rejected` is the *employer's* answer to an
-- application already sent, and so can only follow `applied`. That ordering is
-- deliberately not enforced — a person may revise any of these in any
-- direction, including back to `new`, and a CHECK that said otherwise would
-- only ever be in the way. The constraint says which words exist, nothing more.
--
-- `not-interested`, not `not_interested`: `documents_doc_type_check` already
-- admits `'cover-letter'`, so a hyphen is how this schema spells a multi-word
-- CHECK value.
--
-- No backfill, and none is possible. The new value means a decision a person
-- took, and no column records that they took it — every existing row keeps
-- whatever it holds. The column default stays `new`.
--
-- Forward-only, like every migration here. Dropping and re-adding is the whole
-- of it: Postgres has no ALTER for a CHECK body, and the new set is a superset
-- of the old one, so the ADD cannot fail on existing data.

ALTER TABLE "postings" DROP CONSTRAINT "postings_status_check";

ALTER TABLE "postings" ADD CONSTRAINT "postings_status_check"
  CHECK ("status" IN ('new', 'applied', 'not-interested', 'rejected'));
