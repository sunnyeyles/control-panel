# What a Testing-status Google OAuth app costs over time

Research for [#63](https://github.com/sunnyeyles/control-panel/issues/63) (part
of #59). Question: what does a Google Cloud OAuth app in **Testing** publishing
status cost us over time, given `gmail.readonly` is a **restricted** scope and
this app will never be verified?

Everything below is sourced from pages Google owns — `developers.google.com`,
`support.google.com`, `cloud.google.com`. No Stack Overflow, no blog posts. Where
Google's docs are silent on something widely believed, the verdict says
**undocumented** rather than repeating the folklore.

Dated doc-text comparisons come from Internet Archive snapshots of the Google
page itself, so the evidence is still Google's own wording — only the timestamp
comes from elsewhere.

Researched 2026-07-30.

---

## 1. Refresh token expiry in Testing status

**Claim.** A refresh token issued by an app whose publishing status is
**Testing** expires in **7 days**.

**Verdict: CONFIRMED.** Stated twice, in both the protocol reference and the
current Google Auth Platform console help. It is not folklore.

> A Google Cloud Platform project with an OAuth consent screen configured for an
> external user type and a publishing status of "Testing" is issued a refresh
> token expiring in 7 days, unless the only OAuth scopes requested are a subset
> of name, email address, and user profile (through the `userinfo.email`,
> `userinfo.profile`, `openid` scopes, or their OpenID Connect equivalents).

— <https://developers.google.com/identity/protocols/oauth2#expiration>

> Authorizations by a test user will expire seven days from the time of consent.
> If your OAuth client requests an offline access type and receives a refresh
> token, that token will also expire.

— <https://support.google.com/cloud/answer/15549945> ("Manage App Audience",
Google Auth Platform → Publishing status → Testing)

### All scopes, or only sensitive/restricted ones?

**All scopes.** The widely repeated variant "it only bites sensitive or
restricted scopes" is **REFUTED**. The documented carve-out is the opposite
shape: the 7-day clock applies to _everything except_ a subset of basic identity
(`openid`, `userinfo.email`, `userinfo.profile`). A merely _non-sensitive_ scope
that is not one of those three is still subject to it. From the same Audience
page:

> The only exception to this behavior is if your app requests a subset of the
> following: name, email address, and user profile … If your app requests any
> other OAuth scopes, then this exception does not apply.

`gmail.readonly` is squarely outside the carve-out, so this app is affected.

### Did the newer Google Auth Platform console change it?

**No.** The clearest evidence is that the sentence is published _on the Google
Auth Platform help pages themselves_ — `support.google.com/cloud/answer/15549945`
is the new console's own documentation ("Manage your app publishing status in the
Audience page of the Google Auth Platform"), and it states the seven days. The
console was renamed and the setting moved from "OAuth consent screen" to
**Audience**; the behaviour did not move with it.

### Does the clock run from issue, or from last use?

**From consent/issue.** The Audience page is explicit: "expire seven days from
the time of consent." The protocol page says the token "is issued … expiring in
7 days." Neither anchors the clock to last use.

Note also that what expires is the **authorization**, not just one token — "the
authorization will expire … that token will also expire." So there is no reading
under which exercising the refresh token extends the grant.

**Whether a successful refresh resets the 7 days is UNDOCUMENTED**, but the
wording ("from the time of consent", and the authorization itself expiring) makes
a reset implausible, and nothing in Google's docs suggests one. Do not design
around a reset.

Separately worth knowing for error handling: the token endpoint does **not**
advertise this deadline. `refresh_token_expires_in` "is only set when the user
grants time-based access"
(<https://developers.google.com/identity/protocols/oauth2/web-server#exchange-authorization-code>),
which the Testing 7-day clock is not. The application therefore cannot see the
expiry coming in the token response; it only finds out at the failed refresh.

### This behaviour is itself a change Google made — with dates

Recording this because it explains why the internet disagrees with itself.
Snapshots of `developers.google.com/identity/protocols/oauth2`:

| When                                       | What the page said                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 2019-06 through 2020-11-29                 | No 7-day rule at all. Refresh tokens expired only on revoke / six months unused / password change with Gmail scopes / too many live tokens. |
| First seen **2020-12-05**                  | The 7-day sentence appears, **with no exception clause** — it applied to every scope, including basic identity.                             |
| 2022-07-07 → 2022-09-01                    | The per-account-per-client refresh token limit is raised from **50 to 100**.                                                                |
| 2023-02-01 (absent) → 2023-06-01 (present) | The "subset of name, email address, and user profile" exception is added, exempting `openid`/`userinfo.*` from the 7-day clock.             |

The 2020-12-05 wording, verbatim, for contrast with today's:

> A Google Cloud Platform project with an OAuth consent screen configured for an
> external user type and a publishing status of "Testing" is issued a refresh
> token expiring in 7 days.

— <https://web.archive.org/web/20201205032543/https://developers.google.com/identity/protocols/oauth2>

Consequence: any advice written before December 2020 predates the rule entirely,
and anything between then and mid-2023 predates the identity-scope carve-out.
That is where the "it only applies to sensitive scopes" folklore comes from —
people generalising from the carve-out in the wrong direction.

---

## 2. What "restricted scope" changes while the app stays in Testing

**Claim.** `gmail.readonly`'s restricted classification alters token lifetime,
consent, or the refresh flow while the app is in Testing.

**Verdict: REFUTED for token lifetime and the refresh flow; partially
CONFIRMED for consent.**

First, the classification itself is confirmed. `gmail.readonly` is listed under
**Restricted scopes** on the Gmail API scopes page, and restricted means "wide
access to Google user data" requiring restricted-scope verification:
<https://developers.google.com/workspace/gmail/api/auth/scopes>

What restricted does **not** change in Testing:

- **Token lifetime.** The 7-day rule is keyed on publishing status and user type,
  not on scope risk. A non-sensitive scope outside the identity carve-out gets
  exactly the same 7 days
  (<https://developers.google.com/identity/protocols/oauth2#expiration>).
- **The refresh flow.** The `grant_type=refresh_token` exchange is documented
  identically for all scopes
  (<https://developers.google.com/identity/protocols/oauth2/web-server#offline>).
- **Verification burden while in Testing.** "If your app is in the development,
  testing, or staging phases, verification isn't required" — including for
  restricted scopes, and including the third-party security assessment
  (<https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>,
  "Exceptions to verification requirements").

What restricted **does** change:

- **The consent screen carries a warning either way**, but the warning is a
  function of "unverified + sensitive/restricted scope". In Testing it is the
  tester warning ("confirms the user has test access to your project but should
  consider the risks associated with granting access to their data to an
  unverified app" — Audience page). In production it becomes the unverified-app
  screen, which is _only_ shown for sensitive or restricted scopes
  (<https://support.google.com/cloud/answer/7454865>). So the restricted
  classification is precisely what makes point 4 cost anything at all.
- **A Gmail-specific extra invalidator.** "The user changed passwords **and the
  refresh token contains Gmail scopes**" invalidates the refresh token
  (<https://developers.google.com/identity/protocols/oauth2#expiration>). This is
  the one place where holding a Gmail scope, specifically, shortens a token's
  life — and it applies in every publishing status. See point 7.
- **It bars the cheap escape hatch permanently.** Restricted scopes are the
  reason "just get verified later" is expensive: permitted-application-type
  review plus, if restricted data is stored or transmitted on our servers, an
  annual third-party security assessment
  (<https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>).

---

## 3. The test-user list

**Claim.** Testing status allows a limited list of test users, they must be
Google accounts, and the list is editable without triggering review.

**Verdict: CONFIRMED (100 users; Google Accounts; freely editable), with one
sharp edge.**

- **Cap: 100.** "Projects configured with a publishing status of Testing are
  limited to up to 100 test users listed in the OAuth consent screen"
  (<https://support.google.com/cloud/answer/15549945>). The overview page calls
  it "a hard cap of 100 test users"
  (<https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>).
- **The sharp edge: the quota is consumed, not occupied.** "A test user consumes
  a project's test user quota once added to the project" (same Audience page).
  Removing a test user does not documented-ly give the slot back. For a
  single-user app this is irrelevant, but it means churn on the list is not free.
- **They must be Google Accounts.** "You must manage the list of Google Accounts
  that are involved in the development or testing of your app"
  (<https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>).
  They do **not** have to be accounts you control — nothing in the docs requires
  ownership, only that you add each address. A Brand Account may also authorize
  "if a specified test user manages the Brand Account"
  (<https://support.google.com/cloud/answer/15549945>).
- **Editing does not trigger review.** The list is edited in the console under
  Audience → Test users → Add users
  (<https://developers.google.com/workspace/guides/configure-oauth-consent>).
  Verification, by contrast, is documented as an explicitly initiated action —
  you click **Verify Branding** to "start the evaluation process", or submit a
  data access request
  (<https://support.google.com/cloud/answer/15549049>). No Google page connects
  editing the test-user list to any review. This is a verdict from consistent
  silence plus the documented trigger being elsewhere, not from an affirmative
  sentence.
- **Not every Google Account can be a working test user.** "A test user may be
  unable to authorize scopes … due to the availability of Google Services for the
  account or configured restrictions" — a Workspace domain policy, or an account
  enrolled in Advanced Protection, can block it
  (<https://support.google.com/cloud/answer/15549945>).

---

## 4. What "Publish app" does _without_ verification

**Claim.** Moving an app with restricted scopes to In production without
completing verification still works for the owner, at the cost of a warning
screen and a user cap; and it removes the 7-day refresh token clock.

**Verdict: CONFIRMED on all four sub-questions.** This is the documented escape
hatch, and Google names the use case.

**Does consent still work?** Yes. Google documents "Published / External /
Unverified" as a reachable state — "Any Google user can access. Strongly
discouraged."
(<https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>,
"Google OAuth Platform behavior comparison" table). More directly, Google
documents a **Personal use** exception to verification:

> One use case is if you are the only user of your app or if your app is used by
> only a few users, all of whom are known personally to you. You and your limited
> number of users might be comfortable with advancing through the unverified app
> screen and granting your personal accounts access to your app.

— <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>
("Exceptions to verification requirements" → "Personal use")

And the screen is documented as passable: "During the development phase, you can
continue past this warning by selecting **Advanced > Go to {Project Name}
(unsafe)**."
(<https://developers.google.com/workspace/docs/api/troubleshoot-authentication-authorization>)

**Is there an unverified-app warning?** Yes, and for restricted scopes it is
unavoidable. "Google will display an Unverified apps warning message if your
project's OAuth clients request authorization of scopes considered sensitive or
restricted before your project has completed verification for those scopes"
(<https://support.google.com/cloud/answer/15549945>). It is shown once, at
consent, not on every API call
(<https://support.google.com/cloud/answer/7454865>). A second, quieter cost: with
no brand verification, "the app's name and logo are not displayed on the consent
screen" — only the domain
(<https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>;
<https://support.google.com/cloud/answer/15549049>). The app may also be flagged
in the user's Security Checkup as "risky and unverified"
(<https://support.google.com/cloud/answer/7454865>).

**Is there a user cap?** Yes — **100 users, for the lifetime of the project,
non-resettable.**

> The user cap limits the number of users that can grant permission to your app
> when requesting unapproved sensitive or restricted scopes. The user cap applies
> over the entire lifetime of the project, and it cannot be reset or changed.

— <https://support.google.com/cloud/answer/15549945> ("OAuth user cap"); quota
table: "100 new users in total, after the app presents the unverified app
screen". Also <https://support.google.com/cloud/answer/7454865> and
<https://support.google.com/cloud/answer/9028764>, which adds a separate
_authorization rate_ limit surfacing as `Error 403: rate_limit_exceeded`.

For a single-user app, 100 lifetime grants is not a constraint. It is a hard
ceiling on ever opening this app to other people without verification, and that
ceiling cannot be raised except by verifying.

**Does the refresh-token clock change?** Yes — the 7-day clock goes away.
Documented negatively but unambiguously, in three places, all of which condition
the limit on Testing:

- The rule itself is written "…configured for an external user type **and a
  publishing status of "Testing"**"
  (<https://developers.google.com/identity/protocols/oauth2#expiration>).
- "…the 7-day refresh token expiration limit **for apps in the Testing status**"
  (<https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>).
- The Testing-tier guidance warns "the refresh token lifetime is limited"; the
  Personal-use (published, unverified) guidance carries no such warning
  (<https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>).

No Google page states any expiry for a refresh token issued by an In-production
app. What remains are the invalidators in point 7 — including the Gmail
password-change one, which never goes away.

---

## 5. Is "Internal" user type available to a plain `@gmail.com` owner?

**Claim.** Internal apps skip verification but require a Google Workspace
organisation, so a plain `@gmail.com` owner cannot use it.

**Verdict: CONFIRMED. Ruled out.**

The gate is a Google Cloud **organization resource**, not the user type picker:

> Projects associated with a Google Cloud Organization can configure Internal
> users to limit authorization requests to members of the organization.

— <https://support.google.com/cloud/answer/15549945> ("User Type" → "Internal");
same wording at <https://support.google.com/cloud/answer/15544987>

And an organization resource is not obtainable by a consumer account:

> An organization resource is available for Google Workspace and Cloud Identity
> customers … Once you have created your Google Workspace or Cloud Identity
> account and **associated it with a domain**, your organization resource will be
> automatically created for you.

— <https://cloud.google.com/resource-manager/docs/creating-managing-organization>
("Get an organization resource")

A `@gmail.com` account is neither a Workspace nor a Cloud Identity customer and
has no domain to associate, so no organization resource exists, so Internal
cannot be selected. Google also describes Internal apps as "private and
restricted to users within your own Google Workspace domain"
(<https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>).
The runtime symptom, had we forced it, is documented: "An `org_internal`
authorization error is displayed when authorization is requested from users
outside the Google Cloud project's parent"
(<https://support.google.com/cloud/answer/15549945>).

Worth noting what we are giving up, since it is exactly the thing we want: for a
Workspace org, an admin marking an app **Trusted** "overrides certain standard
OAuth limitations for the organization's users, such as the 100-test-user cap and
the 7-day refresh token expiration limit for apps in the Testing status"
(<https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>).
That is the clean fix, and it requires a paid Workspace/Cloud Identity domain.

---

## 6. Service accounts with domain-wide delegation

**Claim.** A service account with domain-wide delegation cannot reach a consumer
`@gmail.com` mailbox.

**Verdict: CONFIRMED. Ruled out.**

Delegation is defined entirely in terms of a Workspace domain and is configured
from the Google **Admin** console by a super administrator:

> Using a Google Workspace account, a Workspace administrator of the organization
> can authorize an application to access Workspace user data on behalf of users in
> the Google Workspace domain … To delegate domain-wide authority to a service
> account, a super administrator of the Google Workspace domain must complete the
> following steps.

— <https://developers.google.com/identity/protocols/oauth2/service-account>
("Delegate domain-wide authority to the service account")

> To call APIs on behalf of users in a Google Workspace organization, grant your
> service account domain-wide delegation of authority in the Google Admin console
> using a Super Admin account.

— <https://developers.google.com/workspace/guides/create-credentials> ("Optional:
Set up domain-wide delegation for a service account"); the steps land in Admin
console → Security → Access and data control → API controls → Manage Domain Wide
Delegation.

The same page scopes what a service account can reach at all: "You can use a
service account to access data or perform actions by the robot account, or to
access data on behalf of **Google Workspace or Cloud Identity users**" — and
notes that IAM roles "don't grant access to Google Workspace assets (such as
Sheets or Gmail)". Consumer accounts are absent from that list, and a
`@gmail.com` account has no Admin console and no super administrator, so there is
no mechanism by which the authorization could be granted. Impersonation is also
documented as domain-bounded: the delegated subject "must be a user which belongs
to your … domain".

Reading someone's own `@gmail.com` mailbox therefore requires a user OAuth grant.
There is no server-to-server alternative.

---

## 7. What invalidates a refresh token, and what the token endpoint returns

**Verdict: the invalidator list is well documented; the exact
`error_description` strings largely are not.**

### Everything Google documents as invalidating a refresh token

From <https://developers.google.com/identity/protocols/oauth2#expiration> unless
noted:

1. **The user revoked the app's access** — at
   <https://myaccount.google.com/permissions>, or programmatically via the revoke
   endpoint. Blast radius is bigger than one token: "Revocation removes all OAuth
   2.0 scopes previously granted to a project, invalidating any issued access or
   refresh tokens **for all clients registered under that project**"
   (<https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke>).
2. **The refresh token has not been used for six months.**
3. **The user changed passwords and the refresh token contains Gmail scopes.**
   This one hits us by definition — every token we hold carries `gmail.readonly`.
4. **The account exceeded the maximum number of live refresh tokens.** "There is
   currently a limit of 100 refresh tokens per Google Account per OAuth 2.0
   client ID. If the limit is reached, creating a new refresh token automatically
   invalidates the oldest refresh token **without warning**." A separate, larger
   cross-client limit also exists.
5. **Time-based access expired.** Users can grant access for a limited period —
   Google Account settings offer sharing "for 30 or 180 days"
   (<https://support.google.com/accounts/answer/3466521>). When granted, "the
   refresh token will expire after the specified duration", and
   `refresh_token_expires_in` is returned in the code exchange
   (<https://developers.google.com/identity/protocols/oauth2/web-server#time-based-access>).
6. **A Workspace admin set a requested service to Restricted** — error
   `admin_policy_enforced`
   (<https://developers.google.com/identity/protocols/oauth2/web-server#authorization-errors-admin-policy-enforced>).
   Not applicable to a consumer account, but cheap to handle.
7. **GCP session-control policy exceeded**, for apps using the Cloud Platform
   scope (<https://developers.google.com/identity/protocols/oauth2#gcp>).
8. **Testing-status 7-day expiry**, per point 1.

Also: the account itself may have been deleted or disabled
(<https://developers.google.com/identity/protocols/oauth2/web-server#exchange-errors-invalid-grant>).

### What the token endpoint returns

- **Refresh failure is `invalid_grant`.** "When refreshing an access token or
  using incremental authorization, the token may have expired or has been
  invalidated. Authenticate the user again and ask for user consent to obtain new
  tokens."
  (<https://developers.google.com/identity/protocols/oauth2/web-server#authorization-errors-invalid-grant>)
  This is the single error the application must recognise, and it is the same
  code for expiry, revocation, password change, and eviction by the 100-token
  limit — so a failed refresh cannot be attributed to a cause from the response
  alone. Treat every `invalid_grant` on refresh as "the grant is gone,
  re-consent required".
- **`invalid_grant` is also returned at code exchange**, meaning the
  authorization code is invalid or malformed — a different situation with the same
  code, distinguishable only by which call failed
  (<https://developers.google.com/identity/protocols/oauth2/web-server#exchange-errors-invalid-grant>).
- **`error_subtype` disambiguates the GCP session-control case only.** "The call
  will fail with an error type `invalid_grant`; the `error_subtype` field can be
  used to distinguish between a revoked token and a failure due to a session
  control policy (for example, `"error_subtype": "invalid_rapt"`)"
  (<https://developers.google.com/identity/protocols/oauth2#gcp>). Google
  documents no other subtype values, and none for the expiry/revocation cases we
  actually expect.
- **Google's own docs name the client-library-surfaced message** "Token has been
  expired or revoked", and point at Refresh token expiration for causes
  (<https://developers.google.com/workspace/docs/api/troubleshoot-authentication-authorization>).
  That is the closest thing to a documented string.
- **The specific `error_description` values are UNDOCUMENTED.** No Google page
  enumerates them. Matching on `error_description` text is unsupported and will
  break silently; match on `error === "invalid_grant"` and, if you need it,
  `error_subtype`.
- **Revocation endpoint:** `POST https://oauth2.googleapis.com/revoke`. "If the
  revocation is successfully processed, then the HTTP status code of the response
  is 200. For error conditions, an HTTP status code 400 is returned along with an
  error code." Also, "following a successful revocation response, it might take
  some time before the revocation has full effect"
  (<https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke>).
- **Authorization-request errors** (not token endpoint) worth handling on the
  callback: `access_denied` when the user declines,
  `org_internal`, `admin_policy_enforced`, `redirect_uri_mismatch`, and
  `rate_limit_exceeded`
  (<https://developers.google.com/identity/protocols/oauth2/web-server#authorization-errors>,
  <https://support.google.com/cloud/answer/9028764>).
- **Optional pre-warning:** Cross-Account Protection pushes
  `token-revoked`, `sessions-revoked` and `account-disabled` events, so a
  revocation can be learned about before the next refresh fails
  (<https://developers.google.com/identity/protocols/oauth2/web-server#cross-account-protection>).

---

## Verdict

**"Connect once and forget" is not achievable while the app stays in Testing —
and it is achievable, with caveats, the moment we publish.** The 7-day claim is
real, documented twice by Google, scoped to publishing status rather than to
scope risk, measured from the moment of consent rather than from last use, and
unchanged by the Google Auth Platform console rework; because `gmail.readonly`
sits outside the `openid`/`userinfo.*` carve-out, a Testing-status app would
force re-consent every week, which is a re-consent treadmill, not a connect-once
flow. Internal user type and service-account domain-wide delegation are both
ruled out on documented fact — each requires a Google Workspace or Cloud Identity
domain that a `@gmail.com` account cannot have. That leaves exactly one cheap
posture, and Google explicitly blesses it: **set the audience to External, press
"Publish app" to reach In production, and never submit for verification**, which
is the documented "Personal use" exception to verification for an app whose only
users are you and people known to you. The cost is bounded and one-time: at
consent the user must click through an unverified-app warning via **Advanced → Go
to {app} (unsafe)**, the consent screen shows the domain instead of our app name
and logo, the project is permanently capped at 100 lifetime grants (irrelevant at
one user, fatal to ever opening it up without verification), and the app may
appear as "risky and unverified" in the user's Security Checkup. In exchange the
refresh token has no documented expiry. The connect flow must still handle
`invalid_grant` on refresh as "grant gone, re-consent required" and surface a
reconnect action in Settings — not because the token expires on a clock, but
because a Gmail-scoped refresh token dies on any Google password change, after
six months unused, on explicit revocation at myaccount.google.com, or when a
101st token for the same client evicts it silently. That is a rare-event recovery
path, not a weekly ritual, and it is the difference between this design working
and not.
