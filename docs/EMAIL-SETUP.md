# Verification email delivery

The local Supabase stack originally sends confirmation messages to Mailpit at http://127.0.0.1:15434. This captures real verification codes on this computer and does not deliver to personal inboxes. Email confirmation stays enabled in both modes. The signup page now identifies the configured delivery method and links to the local inbox when capture is active.

## Connect Gmail

1. Sign in to the Gmail account you want to send from. Turn on [Google 2-Step Verification](https://myaccount.google.com/security), then create an [App Password](https://myaccount.google.com/apppasswords) named **Senmiva**. Use that App Password, not your normal Google password. Some managed or Advanced Protection accounts do not offer App Passwords; see [Google's instructions](https://support.google.com/accounts/answer/185833).
2. Run `npm run supabase:email:prepare`. Open the ignored `.env.supabase-mail.local` file on your computer. Set `SMTP_ENABLED=true`, enter your Gmail address in `SMTP_USER`, and paste the 16-character App Password into `SMTP_PASS`. The supplied settings use `smtp.gmail.com` and port `465`. Leave `SMTP_FROM` blank to use the same account; `SMTP_TEST_RECIPIENT` is not needed for Gmail. Never paste the password into chat.
3. Run `npm run supabase:email:apply`. The tool validates the profile and changes only this workspace's local Auth container. It preserves database volumes, account records, company/store data and captured messages. A failed replacement restores the previous Auth configuration. Run `npm run supabase:email:check` to inspect the active transport without printing credentials.
4. Restart `npm run dev:connected` so the app reads the updated delivery setting. On signup, choose **Already have a verification code?**, enter the email you registered with Senmiva, and choose **Send a new code**. If you have not registered in Senmiva yet, create the account first. Enter the latest six-digit code from your personal inbox; check spam if necessary. Wait at least one minute between requests.

No new sender domain is needed for this Gmail setup. The sender must match the authenticated account; aliases are not supported by this setup tool. App Passwords are revocable credentials: revoke the Senmiva App Password in Google if you stop using this sender. Gmail is the current development sender; review provider capacity and delivery operations before wider business onboarding.

## Other providers and hosted deployment

The SMTP profile also supports services such as Resend. Its settings are `smtp.resend.com`, port `465`, username `resend`, and an API key as the password. `onboarding@resend.dev` can send only to the email associated with the Resend account, which must be recorded privately as `SMTP_TEST_RECIPIENT`. For other recipients, verify a sender domain and use a From address on that domain. See [Resend testing limits](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain) and [SMTP settings](https://resend.com/docs/send-with-smtp). Preparation never overwrites a completed existing provider profile.

For hosted Supabase, configure the same SMTP sender directly in the project's Authentication email settings, enable Confirm email, and copy `supabase/templates/confirmation.html` into the Confirm signup template. This local tool deliberately cannot alter a cloud project. The confirmation template must include `{{ .Token }}`. Set the web server's nonsecret `AUTH_EMAIL_DELIVERY=smtp`; never put SMTP credentials into web runtime or `NEXT_PUBLIC_*` settings. See [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

## Operational boundaries

- `.env.supabase-mail.local` is ignored by Git and read by local operator tooling only. Existing files are never overwritten by prepare. The tool does not print passwords, API keys, message bodies, recipients or verification codes.
- Startup reapplies an explicitly enabled valid SMTP profile after the Supabase CLI starts Auth. Without an enabled profile, it keeps the active transport and derives the app's safe delivery metadata from Auth. SQL migrations do not configure SMTP.
- Setting `SMTP_ENABLED=false` stops automatic application of that profile; it does not undo a running Auth container's SMTP settings. To return to capture for fixture tests, disable the profile and stop/start the local Supabase stack. This clears its temporary Mailpit inbox while preserving database volumes. Do this before starting the web preview or tests.
- A healthy Auth container and matching settings prove configuration, not inbox delivery. End-to-end external delivery still requires a real provider key, a permitted recipient and a successful email-code verification. Provider quotas, spam filtering and DNS remain external factors.
- Local fixture tests refuse external SMTP before any generated signup. Keep fixture acceptance isolated from real delivery. UI and adapter tests do not send external mail.
- Public signup still requires verified email before new workspace creation. Email transport never grants tenant membership or bypasses confirmation. Staff and paired-device cookies remain separate.
