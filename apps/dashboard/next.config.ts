import type { NextConfig } from "next"

import {
  MAX_ACTION_BODY_BYTES,
  MAX_PROXY_BUFFER_BYTES,
} from "./lib/documents/upload-validation"

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui"],

  /**
   * The Jobs section used to be `/briefings`, and these keep the old URLs
   * working — a bookmark, a link in a run report, an open tab.
   *
   * ⚠️ **The only two `/briefings` strings left in the repo on purpose.** A
   * sweep that renames them to `/jobs` turns each of these into a redirect from
   * a route to itself, which is a loop rather than a no-op.
   *
   * Three things the local docs settle
   * (`next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/redirects.md`,
   * and the routing order in `03-file-conventions/proxy.md`):
   *
   * - **Query values are forwarded automatically**, so
   *   `/briefings?sort=title&page=3` lands on `/jobs?sort=title&page=3` with the
   *   view intact. Writing a query string into `destination` would duplicate
   *   them rather than set them.
   * - **`source` is path-anchored and does not match a nested path**, so
   *   `/briefings` cannot swallow `/briefings/jobs`. The order below is for a
   *   reader, not for the matcher.
   * - **Redirects run before `proxy.ts`**, so an unauthenticated hit on an old
   *   URL is rewritten first and gated second — it lands on the sign-in page
   *   pointing at the new route, not the old one.
   *
   * `permanent: false` (307) rather than 308: a browser that caches a redirect
   * on your own hostname forever is a debugging trap, and there is no SEO stake
   * in a single-user app behind a login.
   */
  async redirects() {
    return [
      {
        source: "/briefings/jobs",
        destination: "/jobs/schedules",
        permanent: false,
      },
      { source: "/briefings", destination: "/jobs", permanent: false },
    ]
  },

  experimental: {
    serverActions: {
      /**
       * Documents are capped at 3 MiB by `lib/documents/upload-validation.ts`;
       * this leaves room for the multipart envelope around one. The default is
       * 1 MB, which a scanned CV does not reliably fit inside.
       *
       * **Imported rather than written as a string, so it cannot drift from
       * `MAX_REQUEST_BYTES`.** It used to read `"4mb"`, which the `bytes`
       * parser resolves to 4 MiB — the same number as the `content-length`
       * check it is supposed to sit above. Next enforces this limit while the
       * body streams, before the action function is called, so at parity it
       * always won and the app's own "That upload is too large." never ran. Two
       * literals that had to stay ordered were kept in two files; now there is
       * one, and a test asserts the ordering. The option takes a byte count as
       * happily as a string.
       */
      bodySizeLimit: MAX_ACTION_BODY_BYTES,
    },

    /**
     * ⚠️ **Must stay strictly above `serverActions.bodySizeLimit`. The ordering
     * is the whole design, not a coincidence.**
     *
     * This applies because the app has a `proxy.ts`: Next clones and buffers
     * every request body so the proxy and the handler can both read it, and
     * this caps that buffer. Exceeding it **does not fail the request** — Next
     * buffers the first N bytes, logs a warning, and lets the request continue
     * with a partial body. Stated outright in the local docs, at
     * `next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`:
     * "The request will not fail or return an error to the client."
     *
     * A truncated multipart body either fails to parse or yields a `File` whose
     * size reports the truncated length — so a size check on it would be
     * checking a number the truncation produced, and an oversized upload could
     * land in S3 as a silently corrupt document.
     *
     * Keeping this ceiling above the Server Action ceiling makes truncation
     * unreachable: the action layer rejects with a real, loud error before this
     * buffer is ever the binding constraint. **Inverting the two reintroduces
     * silent corruption**, and nothing fails loudly to tell you.
     *
     * Imported rather than written as `"6mb"`, for the same reason as the rung
     * below: the ordering these comments insist on should hold by construction,
     * not because two literals in two files in two different units happen to
     * agree. The option takes a byte count as happily as a string.
     *
     * The full ladder, smallest first: client pre-check 3 MiB, authoritative
     * byte check 3 MiB, `content-length` check 4 MiB, the action limit
     * 4 MiB + 128 KiB, Vercel's platform cap ~4.5 MB, this buffer a further
     * 2 MiB above the action limit. Every step is a strict inequality — where
     * two rungs were equal, the lower one was unreachable.
     */
    proxyClientMaxBodySize: MAX_PROXY_BUFFER_BYTES,

    /**
     * Lets the client router reuse a page segment for 30 seconds instead of
     * re-rendering it on the server every single time.
     *
     * Every page here is `force-dynamic` — they read cookies — and the default
     * `dynamic` stale time is **0 seconds, meaning not cached at all**
     * (`next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/staleTimes.md`;
     * the default dropped from 30s to 0s in Next 15). So bouncing between `/`
     * and `/documents` paid a full server round trip in each direction, every
     * time, including for a page visited two seconds earlier.
     *
     * Safe for the one page with mutable content: `app/(app)/documents/actions.ts`
     * calls `refresh()` after an upload or a delete, which clears this cache —
     * so a stale list cannot outlive a change the user just made. Without that
     * call this setting would be a bug rather than a fix.
     *
     * `static` is left at its 5-minute default; nothing here is static.
     */
    staleTimes: {
      dynamic: 30,
    },
  },
}

export default nextConfig
