"use client"

import * as React from "react"

import { authClient } from "@/lib/auth/client"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { BotIcon } from "lucide-react"

/**
 * Built from `@workspace/ui` rather than `@neondatabase/auth-ui`.
 *
 * The prebuilt components ship their own stylesheet, and this repo has exactly
 * one — `packages/ui/src/styles/globals.css`, owned by the UI package. A second
 * one competing with it is a worse trade than a form we write ourselves.
 *
 * There is no sign-up form and there will not be one: signup is closed, and the
 * allowlist in `lib/auth/current-user.ts` is what enforces it.
 *
 * **Google is the only button because it is the only provider.** `neon
 * neon-auth oauth-provider list` returns `google` alone, and a `provider` the
 * project has not enabled is refused with `400 PROVIDER_NOT_SUPPORTED` — so the
 * GitHub button that used to sit here could not work in any environment,
 * including production. Adding one back means enabling the provider in Neon
 * first, not the other way round.
 */
export function SignInForm({
  callbackOrigin,
}: {
  /**
   * Resolved on the server by `resolveCallbackOrigin`. `undefined` means "this
   * environment's own origin is already trusted", which is the case everywhere
   * except a preview deployment — see that module for why preview is different.
   */
  callbackOrigin?: string | undefined
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>()

  async function signIn() {
    setPending(true)
    setError(undefined)

    // `window` is only read here, inside the handler, so it is never touched
    // during the server render of this component.
    const callbackURL = callbackOrigin ?? window.location.origin

    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL,
      })

      // ⚠️ **The SDK does not throw on a refusal**, so this branch is the one
      // that matters and a bare `try`/`catch` is not enough on its own. The
      // Neon client hardcodes `throw: false` into its better-fetch options
      // (`adapter-core`), which means a 4xx resolves as `{ data: null, error }`
      // rather than rejecting. Without this check a refused sign-in left the
      // button on "Redirecting…" for ever and reported nothing.
      if (result?.error) {
        console.error("sign-in: google refused", result.error)
        setError(describe(result.error, callbackURL))
        setPending(false)
        return
      }

      // On success the SDK navigates away, so `pending` deliberately stays set
      // — the button should not flick back to idle underneath the redirect.
    } catch (cause) {
      // Still reachable: a network failure rejects before any response exists
      // for `throw: false` to suppress.
      console.error("sign-in: google failed", cause)
      setError("Could not start sign-in. Try again.")
      setPending(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <BotIcon className="size-6" />
          <CardTitle>Control Panel</CardTitle>
          <CardDescription>
            Sign in to continue. Access is limited to approved accounts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button onClick={signIn} disabled={pending}>
            {pending ? "Redirecting…" : "Continue with Google"}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

/**
 * Names the two failures that are configuration rather than bad luck, because
 * "try again" is actively wrong advice for both — neither clears by retrying,
 * and the fix for each is one command.
 *
 * Naming them in the UI is appropriate here in a way it would not be in a
 * consumer app: signup is closed, so everyone who reaches this page is an
 * approved operator who can act on it. The alternative is what this replaced,
 * where the only signal was a generic sentence and the real code was visible
 * only to someone already reading the browser console.
 */
function describe(error: unknown, callbackURL: string): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined

  if (code === "INVALID_CALLBACKURL") {
    return (
      `${callbackURL} is not a Neon Auth trusted domain, so sign-in cannot ` +
      `start. Add it with \`neon neon-auth domain add\`.`
    )
  }

  if (code === "PROVIDER_NOT_SUPPORTED") {
    return (
      `Google is not enabled for this Neon Auth project. Enable it with ` +
      `\`neon neon-auth oauth-provider\`.`
    )
  }

  return "Could not start sign-in. Try again."
}
