# email-monitor

**Source**: `src/jobs/email-monitor.ts`
**Trigger**: Unread emails in configured Gmail inbox
**Interval**: 5 minutes (configurable via `intervals.emailMonitorMs`)
**Requires**: `emailEnabled: true` (default), `emailUser` and `emailAppPassword`
configured

Polls a Gmail inbox via IMAP for unread emails, uses Claude to extract
vegetable box contents and generate recipe ideas, then emails the recipes
to a configured recipient.

- Guards on `EMAIL_ENABLED` and presence of `EMAIL_USER`/`EMAIL_APP_PASSWORD`
- Connects to Gmail IMAP (`imap.gmail.com`, port 993, secure) via
  `retryWithBackoff` (1 retry — 2 total attempts, 1s backoff); a failed
  attempt's `ImapFlow` instance is discarded and a fresh one constructed for
  the retry, since a rejected `connect()` leaves the instance unusable
- Searches for all unread messages (`{ seen: false }` — no sender or subject
  filters, since every email to the inbox is of interest)
- For each unread email:
  - Parses MIME content via `mailparser` (`simpleParser`)
  - Sends body to Claude to extract the vegetable list (returns `NOT_FOUND`
    for non-veg emails)
  - If vegetables found, sends a second Claude call to generate 3–5 recipe
    ideas
  - Sends the recipes via Nodemailer (Gmail SMTP, port 465) to
    `EMAIL_RECIPIENT`
  - Marks the email as `\Seen` via IMAP so it is not reprocessed
- Per-email errors are reported without blocking other emails
- Exposes `getEmailStatus()` for the dashboard and `/status` endpoint
  (tracks `configured`, `lastCheck`, `lastError`)
- Does not create worktrees, PRs, or GitHub issues
- Does not record tasks in the database
