# Email setup

HSA Locker can receive receipts and EOBs by email. Cloudflare Email Routing hands each message to the Worker, which keeps PDFs and photos (and, for receipts with no attachment, the email body), stores the original `.eml`, and reads each document.

**It needs a domain on your Cloudflare account.** A `workers.dev` address can’t receive email, and there’s no way around that.

- **You have one:** follow **Settings → Receipt forwarding address** in the app (the steps are below too).
- **You don’t:** skip this. **Upload** and **Take photo** do everything email does.

If HSA Locker runs on your own domain (a Worker custom domain or route), that domain is already on your Cloudflare account; the app says so and suggests `hsa-in.<your domain>`.

## What you need

- A domain whose DNS is on your Cloudflare account.
- A **subdomain of it that doesn’t receive email today**, such as `hsa-in.example.com`. A subdomain is a new name in front of your domain.

When you type a domain, the app checks its public nameservers and warns you if it isn’t on Cloudflare.

## Why a subdomain

Turning on Email Routing for a name adds Cloudflare MX records for it, and MX records decide where that name’s mail goes. **Don’t enable Email Routing on a domain that already gets mail elsewhere** (Google Workspace, Fastmail, iCloud…): it would take over delivery.

Email Routing supports subdomains (**Compute → Email Service → Email Routing**, pick the domain, **Settings → Subdomains**). Adding `hsa-in.example.com` creates MX and SPF records for that name only; `example.com`’s mail and provider are untouched.

Keep the app’s hostname and the email subdomain separate (for example the app on `hsa-locker.you.workers.dev`, mail on `hsa-in.example.com`). That’s a recommendation, not a requirement.

## Steps

All Cloudflare steps are in the dashboard under **Compute → Email Service → Email Routing** ([open it](https://dash.cloudflare.com/?to=/:account/email-service/routing)).

1. **Choose the address (in HSA Locker):** in **Settings → Receipt forwarding address**, enter the subdomain and save. HSA Locker shows your address: `hsa-xxxxxxxxxx@hsa-in.example.com`. The `hsa-…` part is a random token. Treat the address like a password: anyone who has it can send documents into your ledger.
2. **Add it in Cloudflare:** pick your domain, open **Settings**, and add the subdomain under **Subdomains**. If Cloudflare offers to set up email for the main domain itself, skip it.
3. **Send its mail to HSA Locker:** under **Routing Rules**, select **Create routing rule**. Enter the address’s name (the `hsa-…` part) and pick the subdomain, set **Action** to **Send to a Worker** and **Destination** to **hsa-locker**, and save.
4. **Send a test:** email a receipt to the address. The page changes from “Waiting for the first email…” to what arrived, and each step gets a check mark.

The routing rule is created in the dashboard. Wrangler 4.113+ can also declare Email Routing addresses in `wrangler.jsonc` (`"addresses": [...]`), but your address contains your private token and your own domain, so HSA Locker doesn’t ship one. A future version may offer an “Automate setup” button that creates the rule with a scoped API token (Email Routing Rules: Edit).

## Forwarding

- **By hand:** forward any email to the address.
- **Automatically:** create a rule in your mail provider that forwards only the senders you want (your insurer, provider portals, pharmacies). Settings → Receipt forwarding address has steps for Gmail, Outlook, Fastmail and iCloud.

### Forwarding confirmations

Gmail (and sometimes iCloud) sends a confirmation message to a new forwarding address before it will forward automatically. HSA Locker recognizes these, doesn’t treat them as documents, and shows the **code and link under “Verification waiting”** in Settings → Receipt forwarding address. Enter the code back in Gmail. The patterns live in `src/shared/logic/verification.ts`; other providers can be added there.

## What gets kept from a message

- PDFs, always.
- Photos (JPEG, PNG, WebP, HEIC) at or above the minimum size (25 KB by default, like HSA Wizard’s “Min Image Size”), except images the email’s HTML shows inline (logos) and files named like logos or signatures.
- Attached emails (“forward as attachment”), opened and searched the same way.
- No usable attachment: the body is saved as a document and read. If it isn’t a receipt, it waits in Review rather than vanishing.
- The raw `.eml`, stored with the first document from each message (open it from an entry’s details).

HEIC photos can be stored but not read by Workers AI; they go to Review. iPhones convert photos to JPEG when you upload them through the browser, so prefer upload for iPhone photos (or use a Gemini key, which reads HEIC).

## Limits and safety

- Mail to any other address at the subdomain is rejected. **Rotate address** makes a new token; the old one stops working immediately.
- Per-message limits (attachments, size) and a daily cap, all adjustable under Settings → Receipt forwarding address → Limits. **Accept new mail** pauses the inbox.
- An optional sender allow list. It’s secondary: auto-forwarded mail keeps the original sender, so it can’t be the main gate.
- Cloudflare rejects messages that fail the sender’s DMARC policy (or both SPF and DKIM) before they reach the Worker. Email Routing’s own size limit is 25 MiB.
- HSA Locker never replies to or bounces incoming mail. Everything is visible in the app.

## Optional: a vanity address on your main domain

To give people `hsalocker@example.com` without touching your main domain’s MX records, create an alias or forwarding rule **at your existing mail provider** that forwards it to the HSA Locker address. Tradeoffs: an extra hop, it depends on that provider’s forwarding and DMARC handling, and forwarded-from-forwarded mail can be rejected by strict senders. HSA Locker doesn’t need it.

## CPU limits

The `email()` handler only checks the recipient, size and limits, and streams the raw message to R2; parsing happens right after. On the Workers free plan (10 ms CPU per invocation) parsing larger messages can still run out of CPU and is retried by the sweeper, then marked failed. **Workers Paid is recommended if you use email.**

## Daily reminder email (optional)

HSA Locker can email you once a day when something is waiting in Review. It uses the Worker's built-in `send_email` binding; no outside email service is involved.

**It needs the inbox above first**, because it sends from the inbox’s subdomain (`reminders@<your inbox subdomain>`). Without a domain on Cloudflare there’s no reminder; the Home screen and the Review badge show what’s waiting.

1. In Cloudflare: **Compute → Email Service → Email Routing → Destination Addresses**, add your email, and click the link in the verification email Cloudflare sends. Sending to verified addresses is free on every plan.
2. In HSA Locker: **Settings → Daily reminder email**, enter the same address and Save.
3. Turn on **the daily reminder**.
4. **Send a test** checks the setup and says what's wrong if it fails.

The reminder comes from `reminders@<your inbox subdomain>`, goes out after 13:00 UTC (8–9 a.m. US Eastern), at most once a day, and only when at least one document needs review.
