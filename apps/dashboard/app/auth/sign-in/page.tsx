import { resolveCallbackOrigin } from "@/lib/auth/callback-origin"

import { SignInForm } from "./sign-in-form"

/**
 * A server component wrapping a client form, purely to read the environment.
 *
 * ⚠️ The form must be a client component, and `VERCEL_BRANCH_URL` is not
 * `NEXT_PUBLIC_`. Reading it here and passing it down keeps it out of the
 * bundle: prefixing it would inline an internal hostname into every visitor's
 * bundle to solve what one prop solves. Why the origin cannot just be
 * `window.location.origin` is in `lib/auth/callback-origin.ts`.
 *
 * **This page prerenders as static, so the read happens at build time**, which
 * is correct rather than a thing to fix with `force-dynamic`: every deployment
 * is its own build and the variable is a property of the branch. It also leaves
 * the page every unauthenticated visitor hits served from the edge.
 */
export default function SignInPage() {
  return <SignInForm callbackOrigin={resolveCallbackOrigin(process.env)} />
}
