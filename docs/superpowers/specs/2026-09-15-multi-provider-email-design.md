# Multi-provider Email Sending

**Date:** 2026-09-15
**Status:** Draft

## Problem

Plunk is deeply coupled to a single email provider (AWS SES). The user does not have or want AWS SES. They need to
send email through one or more providers they actually use (starting with Brevo), be able to change the order of
fallback, enable/disable as many providers as they want, and manage per-provider quotas (e.g. Brevo 300 emails/day).

## Goals

- Per-project provider configuration: each project can enable/disable multiple providers, order them by fallback
  priority, and configure each with its own API key and daily/monthly quota.
- Automatic fallback: if the primary provider fails (error) or its quota is exhausted, automatically try the next
  enabled provider in priority order.
- Redundancy / failover: if all providers are exhausted or failing, the email stays queued and is retried when a
  quota resets — it is not marked FAILED.
- Quotas are tracked **per project** (each project's own provider API key has its own quota budget).
- Architecture is designed so future providers (Mailgun, Resend, ...) can be added with minimal effort.
- SES is an optional provider like any other. If not configured, it is simply not in the list.

## Non-goals (this phase)

- Automatic domain verification via Brevo API. The user verifies the sending domain manually in the Brevo dashboard;
  Plunk uses an already-verified domain.
- Integrating Mailgun / Resend. Only the abstraction is designed to accommodate them later.

## Architecture

### 1. Data model (Prisma)

New model `ProjectEmailProvider` — one row per configured provider for a project:

```
ProjectEmailProvider {
  id          String   @id @default(cuid())
  projectId   String
  provider    ProviderType   // enum: 'ses' | 'brevo'
  enabled     Boolean  @default(true)
  priority    Int      // order of fallback (ascending)
  apiKey      String?  // Brevo API key, encrypted at rest
  dailyQuota  Int?     // null = unlimited
  monthlyQuota Int?    // null = unlimited
  createdAt   DateTime
  updatedAt   DateTime
  @@unique([projectId, provider])   // one config per provider type per project
}
```

Usage/quota counters stored in a new model `ProviderQuotaUsage`, one row per (project, provider, date):

```
ProviderQuotaUsage {
  id         String   @id @default(cuid())
  projectId  String
  providerId String   // FK -> ProjectEmailProvider.id
  date       DateTime @db.Date
  count      Int      @default(0)
  @@unique([providerId, date])
}
```

The `count` is incremented atomically on every successful send (a row per calendar day). Daily quota compares
`count` for today against `dailyQuota`; monthly quota sums the month.

### 2. Provider abstraction

New module defining an `EmailProvider` interface:

```ts
interface EmailProvider {
  type: ProviderType;
  send(email: OutboundEmail): Promise<SendResult>;
  getRemainingQuota(config: ProviderConfig, date: Date): Promise<number>;
}
```

- **`SESProvider`** wraps the existing `SESService.sendRawEmail` and the SES send quota. Retained for users who do use
  SES.
- **`BrevoProvider`** (new) sends via the Brevo transactional email API using the project's API key. Its quota is
  derived from `dailyQuota` / `monthlyQuota` configured on the `ProjectEmailProvider` row (no upstream quota API).

### 3. Dispatcher with fallback + queue

`ProviderDispatcher.send({ project, email })`:

1. Load the project's `ProjectEmailProvider` rows where `enabled = true`, sorted by `priority` ascending.
2. For each provider, check `getRemainingQuota`. If exhausted → skip to next.
3. Attempt `send`. On success → increment `ProviderQuotaUsage`, return.
4. On provider error or quota exhaustion → move to the next provider.
5. If every provider fails or is exhausted → throw a `QuotaExhausted`/`AllProvidersFailed` outcome; the worker
   **re-queues the job with a delay** (does not mark the email FAILED) so it retries once a quota resets.

### 4. Worker

`apps/api/src/jobs/email-processor.ts` currently calls `sendRawEmail` and `getSendingQuota` directly. It will call
`ProviderDispatcher.send` instead. When all providers are unavailable, the job is requeued with a delay rather than
failed.

### 5. Webhook

New endpoint `/api/webhooks/brevo` that validates the Brevo webhook signature and maps Brevo events
(delivery, bounce, complaint, open, click) to Plunk's internal event handling, mirroring the existing SES/SNS path.

### 6. Configuration (settings UI)

Per-project settings to:
- add a provider,
- enable / disable it,
- reorder fallback priority (drag / up-down),
- set daily and monthly quota,
- set the provider API key.

## Quota semantics

- Quota is tracked **per project** (each project's own provider API key has its own budget).
- When a provider's daily quota is exhausted, fallback to the next enabled provider.
- If all enabled providers are exhausted, the email stays queued and retries when a quota resets.

## Error handling

- Provider hard failure (auth error, invalid domain) → attempt next provider, then queue if all fail.
- All exhausted → requeue with delay, do not mark FAILED.

## Testing

- Unit tests for `BrevoProvider.send` (mocked Brevo API).
- Unit tests for `ProviderDispatcher` fallback ordering, quota skipping, and all-exhausted requeue behaviour.
- Unit tests for quota usage increment and daily/monthly reset.
- Webhook signature validation and event mapping tests.
- Migrate existing SES-based tests to the new provider abstraction where feasible.

## Open questions

None outstanding.
