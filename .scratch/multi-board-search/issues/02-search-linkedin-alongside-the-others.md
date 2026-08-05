# 02 — Search LinkedIn alongside the others

**What to build:** the third board, over Apify's `curious_coder/linkedin-jobs-scraper`,
registered as a descriptor beside the others. Same shape as 01 — a typed exported
function with a thin `tool()` wrapper, the same five-field request, the same failure
split.

**This ticket does not depend on 01.** Both need only 00, and each is a board built to a
shape that already exists. They can land in either order or at the same time.

## Known actor behaviour, measured 2026-08-05

- **Request**: `urls` (an array of linkedin.com/jobs search URLs), `count`,
  `scrapeCompany: false`. Roughly 20–30s.
- **`count` has a hard floor of 10.** The actor rejects anything lower with
  `Field input.count must be >= 10`. Absorb that inside the adapter — clamp up and slice
  the result — rather than leaking a board's floor into the shared `maxResults` field.
- **Response fields**: `link`, `title`, `companyName`, `location`, `descriptionText`,
  `descriptionHtml`, `postedAt` (`YYYY-MM-DD`), `employmentType`, `seniorityLevel`,
  `salary`, `applicantsCount`. Descriptions were present on 10 of 10, 2.5k–4.8k chars.
- **`applyUrl` was empty on every result.** Do not build on it.
- **URLs are canonical** — `https://au.linkedin.com/jobs/view/{slug}-4446494860`, id in
  the path. They arrive decorated with `position`, `pageNum`, `refId` and `trackingId`;
  00 strips those per-host, and without 00 every run re-mints every id. Note the host is
  `au.linkedin.com` even when the search URL was `www.linkedin.com`.
- **The slug is title-and-company-derived**, so a retitled advertisement still churns its
  id. Not solvable here; 03 owns the general answer.

**The actor takes a search URL, not parameters.** The adapter builds one: keywords and
location into the query string, `daysOld` into LinkedIn's seconds-based recency filter,
`workType` into its employment-type codes. That translation lives inside the adapter and
is unit-testable on its own. A single search URL caps at 1,000 results; record that
beside the builder.

**The terms position must be decided before implementation and recorded in the adapter's
docblock**, stating that the actor runs without cookies or a personal LinkedIn account.
`seek-search.ts` records SEEK's equivalent as an explicit product decision rather than a
technical default, and LinkedIn is a stronger version of the same question. It is not
inherited from another board.

**`OVERVIEW.md` is this ticket's to fix.** Its "Not built yet" section lists "Several
scouts, merged and ranked", which this work closes — and closes differently from how it
is drawn. The fan-out is not several Scouts; it is one Scout ranking a pool several
boards fed. Update the prose and the diagram node together.

**Blocked by:** 00 — Scope tracking parameters per board.

**Status:** ready-for-agent

- [ ] The LinkedIn board returns currently-open postings, each with its canonical URL,
      listing date and the advertisement's own description
- [ ] It is a typed exported function with a thin `tool()` wrapper, matching 01's shape
- [ ] Its request shape matches the other boards'; the `count >= 10` floor and the URL
      building are internal, and both are tested directly along with the recency and
      employment-type translations
- [ ] Asking for fewer than ten results returns that many, not ten
- [ ] Failure posture matches SEEK's and Indeed's
- [ ] The docblock states the terms position explicitly, including that no personal
      LinkedIn account authenticates the requests
- [ ] Two runs of one search yield the same `postingId` for the same posting — the
      regression 00 fixes, asserted here against a live pair
- [ ] `OVERVIEW.md`'s "Not built yet" entry for scout fan-out is closed, prose and diagram
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean

**Not in this ticket:** grouping duplicates across boards (03) and measuring a three-board
run (06).
