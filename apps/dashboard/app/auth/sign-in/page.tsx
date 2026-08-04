import { resolveCallbackOrigin } from "@/lib/auth/callback-origin"

import { SignInForm } from "./sign-in-form"

/**
 * A server component wrapping a client form, purely to read the environment.
 *
 * The form has to be a client component — it holds pending state and calls the
 * browser auth client — and `VERCEL_BRANCH_URL` is not a `NEXT_PUBLIC_`
 * variable, so it is not in the browser bundle. Reading it here and passing the
 * result down keeps it that way: prefixing it instead would inline the value at
 * build time (`next/dist/docs/01-app/02-guides/environment-variables.md`) and
 * publish an internal hostname to every visitor of every environment, to solve
 * a problem one prop already solves.
 *
 * Why the origin cannot simply be `window.location.origin` — the reason this
 * split exists at all — is in `lib/auth/callback-origin.ts`.
 *
 * **This page prerenders as static, so the read happens at build time**, and
 * that is fine rather than a thing to correct with `force-dynamic`. Every
 * deployment is its own build, and `VERCEL_BRANCH_URL` is a property of the
 * branch, so the baked value is the right one for any deployment that can serve
 * this HTML. Keeping it static also leaves the one page an unauthenticated
 * visitor always hits served from the edge. A variable that genuinely varied
 * per request would need `force-dynamic` here — this one does not.
 */
export default function SignInPage() {
  return <SignInForm callbackOrigin={resolveCallbackOrigin(process.env)} />
}
