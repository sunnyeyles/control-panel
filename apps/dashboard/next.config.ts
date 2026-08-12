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
   * sweep that renames them to `/jobs` turns each into a redirect to itself.
   *
   * Query values are forwarded automatically, so writing a query string into
   * `destination` would duplicate them. `source` is path-anchored, so
   * `/briefings` cannot swallow `/briefings/jobs`. `permanent: false` because a
   * 308 cached forever on your own hostname is a debugging trap.
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
       * ⚠️ Imported rather than written as `"4mb"`, so it cannot drift into
       * parity with `MAX_REQUEST_BYTES`. Next enforces this while the body
       * streams, before the action runs, so at parity it always won and the
       * app's own "That upload is too large." never ran.
       */
      bodySizeLimit: MAX_ACTION_BODY_BYTES,
    },

    /**
     * ⚠️ **Must stay strictly above `serverActions.bodySizeLimit`.** This caps
     * the body buffer Next clones for `proxy.ts`, and exceeding it does *not*
     * fail the request — Next keeps the first N bytes, warns, and continues
     * with a partial body (`…/proxyClientMaxBodySize.md`: "The request will not
     * fail or return an error to the client"). A truncated multipart body can
     * land in S3 as a silently corrupt document, so inverting the two rungs
     * reintroduces that with nothing failing loudly to say so.
     *
     * The ladder, smallest first: client pre-check 3 MiB, byte check 3 MiB,
     * `content-length` 4 MiB, action limit 4 MiB + 128 KiB, Vercel ~4.5 MB,
     * this buffer 2 MiB above the action limit. Every step is a strict
     * inequality; where two rungs were equal, the lower one was unreachable.
     */
    proxyClientMaxBodySize: MAX_PROXY_BUFFER_BYTES,

    /**
     * Lets the client router reuse a page segment for 30s. Every page here is
     * `force-dynamic`, and the `dynamic` default is 0 — not cached at all since
     * Next 15 — so bouncing between two pages paid a full server round trip
     * each way.
     *
     * ⚠️ Safe only because `app/(app)/documents/actions.ts` calls `refresh()`
     * after an upload or delete. Without that this setting is a bug.
     */
    staleTimes: {
      dynamic: 30,
    },
  },
}

export default nextConfig
