import { CoverLetterDownloadLink } from "@/components/briefings/cover-letter-download-link"
import { CreateCoverLetterButton } from "@/components/briefings/create-cover-letter-button"
import { DraftCoverLetterButton } from "@/components/briefings/draft-cover-letter-button"
import { EditCoverLetterButton } from "@/components/briefings/edit-cover-letter-button"
import type { CoverLetterRow } from "@/lib/cover-letters/cover-letter-rows"
import type { PostingView } from "@/lib/postings/list-postings"

/**
 * One advertisement in full, shown in the expanded table row beneath it.
 *
 * The compact row carries only what is worth scanning — title, company,
 * location, status, the two sighting times, and whether a letter exists.
 * Everything a row has no width for lives here: the summary, the highlights
 * copied from the advertisement, why it matched, which Briefing found it, and
 * all three Cover Letter controls.
 *
 * ⚠️ **Rendering this costs no round trip.** It takes the whole
 * {@link PostingView} as props, which the page already holds. Opening a letter
 * for editing is the opposite: {@link EditCoverLetterButton} fetches the body
 * on demand into the shared `FileEditorDialog`, so the table never
 * server-renders every letter's markdown.
 *
 * ⚠️ **All three letter controls live here, together.** Editing is offered
 * nowhere else in the app, so leaving it behind when moving drafting would
 * delete the letter editor, and nothing would fail to compile to say so.
 */
export function PostingDetail({
  posting,
  letter,
}: {
  posting: PostingView
  /**
   * The letter already drafted for this Posting, if there is one.
   *
   * `CoverLetterRow` is already the table's narrow client-safe shape. Its
   * `draftedAt` is formatted on the server, so no `Date` crosses into this
   * client tree.
   */
  letter?: CoverLetterRow
}) {
  /**
   * `summary` is absent exactly when the stored payload no longer matched the
   * schema — see `toView()` in `lib/postings/list-postings.ts`, which degrades
   * such a row to its projected columns rather than dropping it. `matchReason`
   * and `highlights` go with it, so one branch covers all three.
   */
  const detailUnreadable = posting.summary === undefined

  return (
    <div className="flex flex-col gap-5 py-2">
      {/*
        A plain anchor, not `next/link`: this leaves the app entirely, and
        prefetching a third party's advertisement site is neither useful nor ours to
        do. `noreferrer` keeps the board from being told where the click
        came from, and `noopener` keeps the opened tab from reaching back.
      */}
      <a
        href={posting.url}
        target="_blank"
        rel="noreferrer noopener"
        className="self-start text-sm underline underline-offset-4 hover:no-underline"
      >
        Open the advertisement
        <span className="sr-only"> for {posting.title}, in a new tab</span>
      </a>

      {detailUnreadable ? (
        <p className="text-sm text-muted-foreground">
          The details this posting was found with could not be read, so only
          what the table shows is available. The advertisement itself still
          opens above.
        </p>
      ) : (
        <>
          <Section title="Summary">
            <p className="text-sm whitespace-normal">{posting.summary}</p>
          </Section>

          {posting.highlights.length > 0 ? (
            <Section title="From the advertisement">
              <ul className="list-disc pl-5 text-sm whitespace-normal text-muted-foreground">
                {/*
                  Keyed by position, not by the line itself: highlights are
                  copied from an advertisement and two identical bullets are
                  a thing an advertisement does. The list is never reordered
                  or filtered, so an index is a stable key here.
                */}
                {posting.highlights.map((highlight, index) => (
                  <li key={`${posting.id}-${index}`}>{highlight}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="Why it matched">
            <p className="text-sm whitespace-normal text-muted-foreground">
              {posting.matchReason}
            </p>
          </Section>
        </>
      )}

      <Section title="Seen">
        {/*
          Both sighting times, which is the pair the table splits across two
          columns and the reason this table exists at all: a Posting
          accumulates across Runs, so "found once, weeks ago" and "still
          being re-found this morning" are different things, and only these
          two fields tell them apart.

          The Briefing is here rather than in a column of its own because it
          is the same kind of fact — provenance of the sighting, not
          something to scan a page of rows for.
        */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <dt>Found by</dt>
          <dd>{posting.briefing}</dd>
          <dt>First seen</dt>
          <dd>{posting.firstSeen}</dd>
          <dt>Last seen</dt>
          <dd>{posting.lastSeen}</dd>
        </dl>
      </Section>

      <Section title="Cover letter">
        {/*
          A Posting with a letter says so, and offers the letter. Without
          this the detail offers a *first* draft for something already
          drafted, which is the one thing a user cannot tell from the button
          alone — and it would take clicking it, and spending a model call,
          to find out.
        */}
        {letter ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
            <span>Drafted {letter.draftedAt}.</span>
            <CoverLetterDownloadLink letter={letter} />
          </p>
        ) : null}

        {/*
          A row, so the two actions on a drafted Posting read as
          alternatives to each other — replace what the model wrote, or edit
          it. The draft button renders its own column (a form stacked over
          its alert), which nests inside this row unchanged.
        */}
        <div className="flex flex-wrap items-start gap-2">
          <DraftCoverLetterButton
            postingId={posting.id}
            title={posting.title}
            drafted={letter !== undefined}
          />

          {!letter ? (
            <CreateCoverLetterButton
              postingId={posting.id}
              title={posting.title}
            />
          ) : null}

          {/*
            Conditional on the letter for the reason the download link is:
            with nothing drafted there is nothing to edit, and the editor
            would open on an empty document.

            Edit opens `FileEditorDialog` — the shared rich-text editor —
            after fetching `/api/cover-letters/[postingId]`. That identity is
            exactly what this table is keyed on.
          */}
          {letter ? (
            <EditCoverLetterButton
              postingId={letter.postingId}
              displayName={letter.displayName}
              filename={letter.filename}
            />
          ) : null}
        </div>
      </Section>
    </div>
  )
}

/**
 * A labelled block of the detail.
 *
 * A heading per section rather than an undifferentiated stack of paragraphs:
 * the summary, the copied highlights and the reason it matched come from three
 * different places and read as one wall of text without labels.
 */
function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}
