"use client"

import { createAuthClient } from "@neondatabase/auth/next"

/**
 * The browser-side Neon Auth client.
 *
 * Takes no base URL: it talks to `/api/auth/[...path]` in this app, which
 * proxies to the branch's auth server. That indirection is the point — the
 * upstream URL and the cookie secret stay on the server, and the browser only
 * ever sees a same-origin route.
 *
 * ⚠️ The return-type annotation is not decoration. Without it, TS2742: the
 * inferred type reaches into `@neondatabase/auth`'s nested `jose`, which pnpm's
 * isolated layout gives no nameable path from here.
 */
export const authClient: ReturnType<typeof createAuthClient> =
  createAuthClient()
