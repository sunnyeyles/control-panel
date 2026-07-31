"use server"

import { revalidatePath } from "next/cache"

import { getCurrentUser } from "@/lib/auth/current-user"
import { getDb } from "@/lib/db"
import { revokeToken } from "@/lib/mailbox/google"

/**
 * Disconnect the Mailbox: revoke the grant at Google, then forget the row.
 *
 * Revocation is best-effort and the local delete is not. Forgetting locally
 * while the grant lives on at Google would leave standing access the app no
 * longer admits to holding, so we ask Google first — but a revoke that fails
 * (network, an already-lapsed token) must not leave the user unable to
 * disconnect, so the delete happens regardless and the failure is logged by
 * shape only. The grant, if it survived, is visible and revocable by the
 * user at myaccount.google.com.
 */
export async function disconnectMailbox(): Promise<void> {
  const user = await getCurrentUser()
  if (user.status !== "ok") throw new Error("Unauthorized")

  const db = getDb()

  try {
    const refreshToken = await db.mailboxes.refreshToken(user.userId)
    if (refreshToken) {
      const revoked = await revokeToken(refreshToken)
      if (!revoked) {
        console.error(
          "mailbox: revoke at Google failed; forgetting locally anyway"
        )
      }
    }
  } catch (error) {
    // A row that cannot be decrypted (rotated key) must still be forgettable.
    console.error("mailbox: revoke skipped", error)
  }

  await db.mailboxes.disconnect(user.userId)
  revalidatePath("/settings")
}
