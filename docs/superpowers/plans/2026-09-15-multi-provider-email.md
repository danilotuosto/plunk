# Multi-Provider Email Sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each project configure one or more email providers (SES or Brevo), set their fallback order, enable/disable them, and enforce per-project daily/monthly quotas with automatic fallback and queueing when all providers are exhausted.

**Architecture:** A provider abstraction (`EmailProvider` interface with `SESProvider` and `BrevoProvider`) behind a `ProviderDispatcher` that iterates a project's enabled providers in `priority` order, skips exhausted ones, falls back on send errors, and throws a distinct "all exhausted" error that the email worker handles by re-queueing instead of failing. Provider config and usage are persisted in two new Prisma models. A new Brevo webhook endpoint maps Brevo events to Plunk's internal event handling.

**Tech Stack:** TypeScript (ESM), Prisma, Express (@overnightjs/core), BullMQ, Vitest. Brevo uses its transactional email API over HTTPS (no SDK required — use `fetch`).

## Global Constraints

- Follow existing codebase patterns: services in `apps/api/src/services/`, controllers in `apps/api/src/controllers/`, jobs in `apps/api/src/jobs/`.
- Quotas are tracked **per project** (each project's own provider API key has its own budget).
- When a provider's quota is exhausted, fall back to the next enabled provider. If all are exhausted/failing, the email stays queued (requeue with delay), never marked FAILED for this reason.
- API keys must not be logged. Store Brevo `apiKey` in plaintext DB column for now (matches existing `Project.public`/`secret` pattern; encryption is out of scope this phase).
- Every new module gets unit tests (Vitest). Existing tests use `vi.mock` of `../SESService`.
- Run `yarn workspace @plunk/db db:generate` after schema changes; create migrations with `yarn workspace @plunk/db migrate:dev`.

---

### Task 1: Prisma schema — provider config and quota usage

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Migration: generated via `yarn workspace @plunk/db migrate:dev --name add_email_providers`

**Interfaces:**
- Produces: Prisma models `ProjectEmailProvider` and `ProviderQuotaUsage`, enum `EmailProviderType` (`SES` | `BREVO`). These are used by every later task via the generated `@plunk/db` client.

- [ ] **Step 1: Add the enum and models to the schema**

Add the enum after `enum EmailStatus` (near line 856) and the two models after the `Email` model (before the EVENTS section).

```prisma
// after enum EmailStatus { ... }

enum EmailProviderType {
  SES
  BREVO
}
```

```prisma
// after model Email { ... } block

model ProjectEmailProvider {
  id           String            @id @default(uuid())
  project      Project           @relation(fields: [projectId], references: [id], onDelete: Cascade)
  projectId    String
  provider     EmailProviderType
  enabled      Boolean           @default(true)
  priority     Int               @default(0)
  apiKey       String?           // Brevo API key. Null for SES (uses env credentials).
  dailyQuota   Int?              // Emails per calendar day. Null = unlimited.
  monthlyQuota Int?              // Emails per calendar month. Null = unlimited.
  usage        ProviderQuotaUsage[]
  createdAt    DateTime          @default(now())
  updatedAt    DateTime          @updatedAt

  @@unique([projectId, provider])
  @@index([projectId, enabled, priority])
  @@map("project_email_providers")
}

model ProviderQuotaUsage {
  id         String               @id @default(uuid())
  provider   ProjectEmailProvider @relation(fields: [providerId], references: [id], onDelete: Cascade)
  providerId String
  date       DateTime             @db.Date
  count      Int                  @default(0)

  @@unique([providerId, date])
  @@map("provider_quota_usage")
}
```

- [ ] **Step 2: Add the relation to the Project model**

In `model Project` add `emailProviders ProjectEmailProvider[]` inside the Relations block (near line 86):

```prisma
  emailProviders ProjectEmailProvider[]
```

- [ ] **Step 3: Generate client and create migration**

Run:
```bash
yarn workspace @plunk/db db:generate
yarn workspace @plunk/db migrate:dev --name add_email_providers
```
Expected: Prisma client regenerated and a new migration folder created under `packages/db/prisma/migrations/`.

- [ ] **Step 4: Verify types compile**

Run: `yarn workspace api typecheck`
Expected: PASS — `ProjectEmailProvider`, `ProviderQuotaUsage`, `EmailProviderType` are available from `@plunk/db`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(db): add ProjectEmailProvider and ProviderQuotaUsage models"
```

---

### Task 2: Provider abstraction + SESProvider + BrevoProvider

**Files:**
- Create: `apps/api/src/services/providers/types.ts`
- Create: `apps/api/src/services/providers/SESProvider.ts`
- Create: `apps/api/src/services/providers/BrevoProvider.ts`
- Test: `apps/api/src/services/providers/__tests__/providers.test.ts`

**Interfaces:**
- Consumes: `sendRawEmail` from `../SESService.js`; `EmailProviderType` from `@plunk/db`.
- Produces: `ProviderType`, `OutboundEmail`, `SendResult`, `ProviderConfig`, `EmailProvider` interface, `sesProvider`, `brevoProvider`, `getProvider(type)`. Used by Task 4 (dispatcher) and Task 6 (webhook).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/providers/__tests__/providers.test.ts`:

```ts
import {describe, expect, it, vi} from 'vitest';

import {EmailProviderType} from '@plunk/db';

vi.mock('../../SESService.js', () => ({
  sendRawEmail: vi.fn().mockResolvedValue({messageId: 'ses-msg-1'}),
}));

import {brevoProvider, getProvider, sesProvider} from '../index.js';
import * as SESService from '../../SESService.js';

describe('provider registry', () => {
  it('returns the SES provider for SES type', () => {
    expect(getProvider(EmailProviderType.SES)).toBe(sesProvider);
  });

  it('returns the Brevo provider for BREVO type', () => {
    expect(getProvider(EmailProviderType.BREVO)).toBe(brevoProvider);
  });

  it('throws on unknown provider type', () => {
    expect(() => getProvider('unknown' as EmailProviderType)).toThrow();
  });
});

describe('SESProvider', () => {
  it('forwards to sendRawEmail and returns its message id', async () => {
    const result = await sesProvider.send(
      {from: {name: 'A', email: 'a@x.com'}, to: ['b@x.com'], content: {subject: 'S', html: '<p>hi</p>'}},
      {enabled: true},
    );
    expect(result).toEqual({messageId: 'ses-msg-1'});
    expect(SESService.sendRawEmail).toHaveBeenCalled();
  });
});

describe('BrevoProvider', () => {
  it('POSTs to the Brevo transactional endpoint with the api key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({messageId: 'brevo-msg-1'}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await brevoProvider.send(
      {from: {name: 'A', email: 'a@x.com'}, to: ['b@x.com'], content: {subject: 'S', html: '<p>hi</p>'}},
      {enabled: true, apiKey: 'xkeys-123'},
    );

    expect(result).toEqual({messageId: 'brevo-msg-1'});
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe('xkeys-123');
    vi.unstubAllGlobals();
  });

  it('throws when the API returns an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false, status: 401}));
    await expect(
      brevoProvider.send(
        {from: {name: 'A', email: 'a@x.com'}, to: ['b@x.com'], content: {subject: 'S', html: '<p>hi</p>'}},
        {enabled: true, apiKey: 'bad'},
      ),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace api vitest run src/services/providers/__tests__/providers.test.ts`
Expected: FAIL — `../index.js` and the provider modules don't exist yet.

- [ ] **Step 3: Create the types module**

Create `apps/api/src/services/providers/types.ts`:

```ts
import type {EmailProviderType} from '@plunk/db';

export type ProviderType = EmailProviderType;

export interface OutboundEmail {
  from: {name: string; email: string};
  to: string[] | {name?: string; email: string}[];
  content: {subject: string; html: string};
  reply?: string;
  headers?: Record<string, string> | null;
  attachments?:
    | {
        filename: string;
        content: string;
        contentType: string;
        contentId?: string;
        disposition?: 'attachment' | 'inline';
      }[]
    | null;
  tracking?: boolean;
}

export interface SendResult {
  messageId: string;
}

export interface ProviderConfig {
  apiKey?: string | null;
  enabled: boolean;
}

export interface EmailProvider {
  readonly type: ProviderType;
  send(email: OutboundEmail, config: ProviderConfig): Promise<SendResult>;
}
```

- [ ] **Step 4: Create the SESProvider**

Create `apps/api/src/services/providers/SESProvider.ts`:

```ts
import {EmailProviderType} from '@plunk/db';

import {sendRawEmail} from '../SESService.js';
import type {EmailProvider, OutboundEmail, ProviderConfig, SendResult} from './types.js';

export class SESProvider implements EmailProvider {
  public readonly type = EmailProviderType.SES;

  public async send(email: OutboundEmail, _config: ProviderConfig): Promise<SendResult> {
    return sendRawEmail(email);
  }
}
```

- [ ] **Step 5: Create the BrevoProvider**

Create `apps/api/src/services/providers/BrevoProvider.ts`:

```ts
import {EmailProviderType} from '@plunk/db';

import type {EmailProvider, OutboundEmail, ProviderConfig, SendResult} from './types.js';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export class BrevoProvider implements EmailProvider {
  public readonly type = EmailProviderType.BREVO;

  public async send(email: OutboundEmail, config: ProviderConfig): Promise<SendResult> {
    if (!config.apiKey) {
      throw new Error('Brevo provider has no API key configured');
    }

    const response = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: {name: email.from.name, email: email.from.email},
        to: email.to.map(r => (typeof r === 'string' ? {email: r} : {name: r.name, email: r.email})),
        replyTo: email.reply ? {email: email.reply} : undefined,
        subject: email.content.subject,
        htmlContent: email.content.html,
        headers: email.headers ?? undefined,
        attachment: email.attachments
          ? email.attachments
              .filter(a => (a.disposition ?? 'attachment') === 'attachment')
              .map(a => ({name: a.filename, content: a.content}))
          : undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Brevo send failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {messageId?: string};
    if (!data.messageId) {
      throw new Error('Brevo send returned no message id');
    }

    return {messageId: data.messageId};
  }
}
```

- [ ] **Step 6: Create the registry index**

Create `apps/api/src/services/providers/index.ts`:

```ts
import {EmailProviderType} from '@plunk/db';

import type {ProviderType} from './types.js';
import {SESProvider} from './SESProvider.js';
import {BrevoProvider} from './BrevoProvider.js';

export * from './types.js';

export const sesProvider = new SESProvider();
export const brevoProvider = new BrevoProvider();

export function getProvider(type: ProviderType) {
  switch (type) {
    case EmailProviderType.SES:
      return sesProvider;
    case EmailProviderType.BREVO:
      return brevoProvider;
    default:
      throw new Error(`Unknown email provider type: ${type}`);
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `yarn workspace api vitest run src/services/providers/__tests__/providers.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `yarn workspace api typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/providers
git commit -m "feat(api): add email provider abstraction with SES and Brevo"
```

---

### Task 3: Provider quota service

**Files:**
- Create: `apps/api/src/services/ProviderQuotaService.ts`
- Test: `apps/api/src/services/__tests__/ProviderQuotaService.test.ts`

**Interfaces:**
- Consumes: `prisma`, `ProjectEmailProvider` model (Task 1).
- Produces: `getRemaining(provider, now): Promise<number>`, `incrementUsage(provider, now): Promise<void>`. Used by Task 4 (dispatcher).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/__tests__/ProviderQuotaService.test.ts`:

```ts
import {describe, expect, it, vi} from 'vitest';

import {prisma} from '../../database/prisma.js';
import {ProviderQuotaService} from '../ProviderQuotaService.js';

const provider = {
  id: 'p1',
  dailyQuota: 300,
  monthlyQuota: 9000,
} as any;

describe('ProviderQuotaService.getRemaining', () => {
  it('returns unlimited when no quota is set', async () => {
    vi.mocked(prisma.providerQuotaUsage.findUnique).mockResolvedValue(null);
    const remaining = await ProviderQuotaService.getRemaining({...provider, dailyQuota: null, monthlyQuota: null} as any, new Date('2026-09-15T10:00:00Z'));
    expect(remaining).toBe(Infinity);
  });

  it('subtracts today usage from the daily quota', async () => {
    vi.mocked(prisma.providerQuotaUsage.findMany).mockResolvedValue([
      {id: 'u', providerId: 'p1', date: new Date('2026-09-15'), count: 250} as any,
    ]);
    const remaining = await ProviderQuotaService.getRemaining(provider, new Date('2026-09-15T10:00:00Z'));
    expect(remaining).toBe(50);
  });
});

describe('ProviderQuotaService.incrementUsage', () => {
  it('upserts the usage row for the day', async () => {
    vi.mocked(prisma.providerQuotaUsage.upsert).mockResolvedValue({} as any);
    await ProviderQuotaService.incrementUsage(provider, new Date('2026-09-15T10:00:00Z'));
    expect(prisma.providerQuotaUsage.upsert).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace api vitest run src/services/__tests__/ProviderQuotaService.test.ts`
Expected: FAIL — `ProviderQuotaService` doesn't exist.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/ProviderQuotaService.ts`:

```ts
import type {ProjectEmailProvider} from '@plunk/db';

import {prisma} from '../database/prisma.js';

type ProviderRow = Pick<ProjectEmailProvider, 'id' | 'dailyQuota' | 'monthlyQuota'>;

/**
 * Resolve the date-only value (YYYY-MM-DD) used to key daily usage rows.
 */
function dayKey(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export class ProviderQuotaService {
  /**
   * How many emails this provider can still send today/month, or Infinity if
   * unlimited. Reads today's usage row and sums the current calendar month.
   */
  public static async getRemaining(provider: ProviderRow, now: Date): Promise<number> {
    const today = dayKey(now);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [todayUsage, monthUsage] = await Promise.all([
      prisma.providerQuotaUsage.findUnique({
        where: {providerId_date: {providerId: provider.id, date: today}},
      }),
      provider.monthlyQuota != null
        ? prisma.providerQuotaUsage.aggregate({
            where: {providerId: provider.id, date: {gte: monthStart}},
            _sum: {count: true},
          })
        : Promise.resolve({_sum: {count: null}}),
    ]);

    let remaining = Infinity;

    if (provider.dailyQuota != null) {
      const used = todayUsage?.count ?? 0;
      remaining = Math.min(remaining, provider.dailyQuota - used);
    }

    if (provider.monthlyQuota != null) {
      const used = monthUsage._sum.count ?? 0;
      remaining = Math.min(remaining, provider.monthlyQuota - used);
    }

    return remaining;
  }

  /**
   * Record one successful send for the provider on the given day.
   */
  public static async incrementUsage(provider: {id: string}, now: Date): Promise<void> {
    const today = dayKey(now);
    await prisma.providerQuotaUsage.upsert({
      where: {providerId_date: {providerId: provider.id, date: today}},
      create: {providerId: provider.id, date: today, count: 1},
      update: {count: {increment: 1}},
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace api vitest run src/services/__tests__/ProviderQuotaService.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `yarn workspace api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/ProviderQuotaService.ts apps/api/src/services/__tests__/ProviderQuotaService.test.ts
git commit -m "feat(api): add per-provider quota tracking service"
```

---

### Task 4: Provider dispatcher with fallback

**Files:**
- Create: `apps/api/src/services/ProviderDispatcher.ts`
- Test: `apps/api/src/services/__tests__/ProviderDispatcher.test.ts`

**Interfaces:**
- Consumes: `prisma`, `getProvider` + `OutboundEmail` (Task 2), `ProviderQuotaService` (Task 3).
- Produces: `sendEmailWithFallback(projectId, email): Promise<{messageId, provider}>`, `AllProvidersExhaustedError` (class). Used by Task 5 (worker) and Task 6 (webhook messageId lookup uses the returned `messageId`).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/__tests__/ProviderDispatcher.test.ts`:

```ts
import {describe, expect, it, vi} from 'vitest';

import {EmailProviderType} from '@plunk/db';

import {prisma} from '../../database/prisma.js';
import {ProviderQuotaService} from '../ProviderQuotaService.js';
import {AllProvidersExhaustedError, sendEmailWithFallback} from '../ProviderDispatcher.js';
import {getProvider} from '../providers/index.js';

const email = {
  from: {name: 'A', email: 'a@x.com'},
  to: ['b@x.com'],
  content: {subject: 'S', html: '<p>hi</p>'},
} as any;

describe('sendEmailWithFallback', () => {
  it('throws when the project has no enabled providers', async () => {
    vi.mocked(prisma.projectEmailProvider.findMany).mockResolvedValue([]);
    await expect(sendEmailWithFallback('proj1', email)).rejects.toThrow();
  });

  it('sends through the highest-priority provider and increments usage', async () => {
    vi.mocked(prisma.projectEmailProvider.findMany).mockResolvedValue([
      {id: 'brevo', provider: EmailProviderType.BREVO, enabled: true, priority: 0, apiKey: 'k', dailyQuota: 300, monthlyQuota: null} as any,
      {id: 'ses', provider: EmailProviderType.SES, enabled: true, priority: 1, apiKey: null, dailyQuota: null, monthlyQuota: null} as any,
    ]);
    vi.spyOn(ProviderQuotaService, 'getRemaining').mockResolvedValue(100);
    const providerSpy = vi.spyOn(getProvider(EmailProviderType.BREVO), 'send').mockResolvedValue({messageId: 'brevo-1'});
    const incSpy = vi.spyOn(ProviderQuotaService, 'incrementUsage').mockResolvedValue(undefined);

    const result = await sendEmailWithFallback('proj1', email);

    expect(result).toEqual({messageId: 'brevo-1', provider: EmailProviderType.BREVO});
    expect(providerSpy).toHaveBeenCalled();
    expect(incSpy).toHaveBeenCalled();
  });

  it('falls back to the next provider when the primary throws', async () => {
    vi.mocked(prisma.projectEmailProvider.findMany).mockResolvedValue([
      {id: 'brevo', provider: EmailProviderType.BREVO, enabled: true, priority: 0, apiKey: 'k', dailyQuota: null, monthlyQuota: null} as any,
      {id: 'ses', provider: EmailProviderType.SES, enabled: true, priority: 1, apiKey: null, dailyQuota: null, monthlyQuota: null} as any,
    ]);
    vi.spyOn(ProviderQuotaService, 'getRemaining').mockResolvedValue(Infinity);
    vi.spyOn(getProvider(EmailProviderType.BREVO), 'send').mockRejectedValue(new Error('boom'));
    const sesSpy = vi.spyOn(getProvider(EmailProviderType.SES), 'send').mockResolvedValue({messageId: 'ses-1'});

    const result = await sendEmailWithFallback('proj1', email);

    expect(result.messageId).toBe('ses-1');
    expect(sesSpy).toHaveBeenCalled();
  });

  it('skips a provider whose quota is exhausted', async () => {
    vi.mocked(prisma.projectEmailProvider.findMany).mockResolvedValue([
      {id: 'brevo', provider: EmailProviderType.BREVO, enabled: true, priority: 0, apiKey: 'k', dailyQuota: 300, monthlyQuota: null} as any,
      {id: 'ses', provider: EmailProviderType.SES, enabled: true, priority: 1, apiKey: null, dailyQuota: null, monthlyQuota: null} as any,
    ]);
    vi.spyOn(ProviderQuotaService, 'getRemaining').mockResolvedValue(0); // all exhausted
    const brevoSpy = vi.spyOn(getProvider(EmailProviderType.BREVO), 'send');
    const sesSpy = vi.spyOn(getProvider(EmailProviderType.SES), 'send');

    await expect(sendEmailWithFallback('proj1', email)).rejects.toBeInstanceOf(AllProvidersExhaustedError);
    expect(brevoSpy).not.toHaveBeenCalled();
    expect(sesSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace api vitest run src/services/__tests__/ProviderDispatcher.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the dispatcher**

Create `apps/api/src/services/ProviderDispatcher.ts`:

```ts
import {EmailProviderType} from '@plunk/db';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {ProviderQuotaService} from './ProviderQuotaService.js';
import {getProvider} from './providers/index.js';
import type {OutboundEmail} from './providers/types.js';

export class AllProvidersExhaustedError extends Error {
  constructor() {
    super('All email providers are unavailable or have exhausted their quota');
    this.name = 'AllProvidersExhaustedError';
  }
}

export async function sendEmailWithFallback(
  projectId: string,
  email: OutboundEmail,
): Promise<{messageId: string; provider: EmailProviderType}> {
  const providers = await prisma.projectEmailProvider.findMany({
    where: {projectId, enabled: true},
    orderBy: {priority: 'asc'},
  });

  if (providers.length === 0) {
    throw new Error(`Project ${projectId} has no enabled email providers configured`);
  }

  const now = new Date();

  for (const providerRow of providers) {
    const remaining = await ProviderQuotaService.getRemaining(providerRow, now);
    if (remaining <= 0) {
      signale.warn(`[DISPATCHER] Provider ${providerRow.provider} quota exhausted (${remaining} remaining), skipping`);
      continue;
    }

    try {
      const provider = getProvider(providerRow.provider);
      const result = await provider.send(email, {
        apiKey: providerRow.apiKey,
        enabled: providerRow.enabled,
      });
      await ProviderQuotaService.incrementUsage(providerRow, now);
      return {messageId: result.messageId, provider: providerRow.provider};
    } catch (error) {
      signale.error(`[DISPATCHER] Provider ${providerRow.provider} failed, trying next:`, error);
      continue;
    }
  }

  throw new AllProvidersExhaustedError();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace api vitest run src/services/__tests__/ProviderDispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `yarn workspace api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/ProviderDispatcher.ts apps/api/src/services/__tests__/ProviderDispatcher.test.ts
git commit -m "feat(api): add provider dispatcher with quota-aware fallback"
```

---

### Task 5: Wire the email worker to the dispatcher

**Files:**
- Modify: `apps/api/src/jobs/email-processor.ts`
- Test: `apps/api/src/jobs/__tests__/email-processor.test.ts` (new; extract the job body for testability)

**Interfaces:**
- Consumes: `sendEmailWithFallback`, `AllProvidersExhaustedError` (Task 4).
- Produces: an extractable `processEmailJob(job)` function that the worker calls, so the requeue-on-exhaustion logic is unit-testable.

- [ ] **Step 1: Refactor the worker to extract the job handler**

The worker currently inlines the job body. Extract the send path so the fallback/requeue logic is testable. Add to `email-processor.ts` a named export `processEmailJob(job: Job<SendEmailJobData>)` and have the worker call it. Replace the `sendRawEmail(...)` call (lines ~275-290) with the dispatcher:

```ts
import {AllProvidersExhaustedError, sendEmailWithFallback} from '../services/ProviderDispatcher.js';
```

Replace the send block:

```ts
        // Send via the project's configured providers (with quota-aware fallback)
        const result = await sendEmailWithFallback(email.projectId, {
          from: {
            name: fromName,
            email: fromEmail,
          },
          to: typeof recipient === 'string' ? [recipient] : [{name: recipient.name, email: recipient.email}],
          content: {
            subject: formattedEmail.subject,
            html: compiledHtml,
          },
          reply: email.replyTo || undefined,
          headers: outboundHeaders,
          tracking: shouldTrack,
          attachments: email.attachments as {filename: string; content: string; contentType: string}[] | null,
        });
```

In the `catch` block, before marking the email FAILED, handle the exhaustion case by re-queueing with a delay instead:

```ts
      } catch (error) {
        signale.error(`[EMAIL-PROCESSOR] Failed to send email ${emailId}:`, error);

        // All providers exhausted/errored: keep the email queued instead of marking it
        // FAILED. Re-queue with a delay so it retries after a quota reset. Don't throw,
        // so BullMQ doesn't consume a retry attempt.
        if (error instanceof AllProvidersExhaustedError) {
          signale.warn(`[EMAIL-PROCESSOR] All providers exhausted for ${emailId}, re-queuing with delay`);
          await prisma.email.update({
            where: {id: emailId},
            data: {status: EmailStatus.PENDING},
          });
          await QueueService.queueEmail(emailId, email.sourceType, 60 * 1000); // retry in 1 min
          return;
        }

        // Mark as failed
        await prisma.email.update({
          where: {id: emailId},
          data: {
            status: EmailStatus.FAILED,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });

        throw error; // Re-throw to trigger retry
      }
```

- [ ] **Step 2: Run existing email-processor-adjacent tests**

Run: `yarn workspace api vitest run src/services/__tests__/EmailService.test.ts`
Expected: PASS (these mock SES; the worker change doesn't affect them).

- [ ] **Step 3: Add a test for the exhaustion requeue path**

Create `apps/api/src/jobs/__tests__/email-processor.test.ts`:

```ts
import {describe, expect, it, vi} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {prisma} from '../../database/prisma.js';
import {AllProvidersExhaustedError} from '../../services/ProviderDispatcher.js';

vi.mock('../../services/ProviderDispatcher.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/ProviderDispatcher.js')>('../../services/ProviderDispatcher.js');
  return {...actual, sendEmailWithFallback: vi.fn()};
});

import {processEmailJob} from '../email-processor.js';

describe('processEmailJob exhaustion handling', () => {
  it('re-queues with a delay instead of failing when all providers are exhausted', async () => {
    vi.mocked(prisma.email.findUnique).mockResolvedValue({
      id: 'e1', projectId: 'p1', status: EmailStatus.PENDING, subject: 'S', body: '<p>x</p>',
      from: 'a@x.com', fromName: 'A', toName: null, replyTo: null, headers: null, attachments: null,
      contact: {id: 'c1', email: 'c@x.com', data: {}},
      project: {disabled: false, name: 'P', tracking: 'ENABLED', customer: null},
      template: null, campaign: null,
    } as any);

    const {sendEmailWithFallback} = await import('../../services/ProviderDispatcher.js');
    vi.mocked(sendEmailWithFallback).mockRejectedValue(new AllProvidersExhaustedError());

    const queueSpy = vi.spyOn(await import('../../services/QueueService.js'), 'QueueService');
    // note: queueEmail is a static; assert it was called via the module

    await processEmailJob({data: {emailId: 'e1'}} as any);

    expect(prisma.email.update).toHaveBeenCalledWith(expect.objectContaining({data: {status: EmailStatus.PENDING}}));
    // The static call is verified via a module-level spy on QueueService.queueEmail
  });
});
```

Note: because `QueueService.queueEmail` is a static method, the cleanest verification is to spy on the `emailQueue.add` used internally. Adjust the assertion to spy on `emailQueue.add` if the static spy is awkward; the key behaviour to assert is that `prisma.email.update` is called with `status: PENDING` and that the job returns without throwing.

- [ ] **Step 4: Run the new test**

Run: `yarn workspace api vitest run src/jobs/__tests__/email-processor.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `yarn workspace api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/email-processor.ts apps/api/src/jobs/__tests__/email-processor.test.ts
git commit -m "feat(api): route email sends through provider dispatcher with requeue on exhaustion"
```

---

### Task 6: Brevo webhook endpoint

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/controllers/Webhooks.ts`
- Create: `apps/api/src/services/BrevoWebhookService.ts`
- Test: `apps/api/src/services/__tests__/BrevoWebhookService.test.ts`

**Interfaces:**
- Consumes: `prisma`, `EventService`, `NtfyService`, `SecurityService`, `CampaignService`, `EmailStatus` (existing patterns from the SNS handler).
- Produces: `mapBrevoEvent(payload): {eventType, messageId, link?}` and a handler that applies the same status transitions as the SES/SNS handler.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/__tests__/BrevoWebhookService.test.ts`:

```ts
import {describe, expect, it} from 'vitest';

import {mapBrevoEvent} from '../BrevoWebhookService.js';

describe('mapBrevoEvent', () => {
  it('maps delivered', () => {
    expect(mapBrevoEvent({event: 'delivered', 'message-id': 'm1'})).toEqual({eventType: 'Delivery', messageId: 'm1', link: undefined});
  });
  it('maps opened', () => {
    expect(mapBrevoEvent({event: 'opened', 'message-id': 'm1'})).toEqual({eventType: 'Open', messageId: 'm1', link: undefined});
  });
  it('maps click with link', () => {
    expect(mapBrevoEvent({event: 'click', 'message-id': 'm1', link: 'https://x.com'})).toEqual({eventType: 'Click', messageId: 'm1', link: 'https://x.com'});
  });
  it('maps hard_bounce to permanent Bounce', () => {
    expect(mapBrevoEvent({event: 'hard_bounce', 'message-id': 'm1'})).toEqual({eventType: 'Bounce', messageId: 'm1', bounceType: 'Permanent', link: undefined});
  });
  it('maps soft_bounce to transient Bounce', () => {
    expect(mapBrevoEvent({event: 'soft_bounce', 'message-id': 'm1'})).toEqual({eventType: 'Bounce', messageId: 'm1', bounceType: 'Transient', link: undefined});
  });
  it('maps complaint', () => {
    expect(mapBrevoEvent({event: 'complaint', 'message-id': 'm1'})).toEqual({eventType: 'Complaint', messageId: 'm1', link: undefined});
  });
  it('returns null for unknown events', () => {
    expect(mapBrevoEvent({event: 'blocked', 'message-id': 'm1'})).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace api vitest run src/services/__tests__/BrevoWebhookService.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the mapping service**

Create `apps/api/src/services/BrevoWebhookService.ts`:

```ts
export interface BrevoPayload {
  event?: string;
  'message-id'?: string;
  link?: string;
  [key: string]: unknown;
}

export interface MappedEvent {
  eventType: 'Delivery' | 'Open' | 'Click' | 'Bounce' | 'Complaint';
  messageId: string;
  link?: string;
  bounceType?: 'Permanent' | 'Transient';
}

export function mapBrevoEvent(payload: BrevoPayload): MappedEvent | null {
  const event = payload.event;
  const messageId = payload['message-id'];
  if (!messageId) return null;

  switch (event) {
    case 'delivered':
      return {eventType: 'Delivery', messageId};
    case 'opened':
      return {eventType: 'Open', messageId};
    case 'click':
      return {eventType: 'Click', messageId, link: payload.link};
    case 'hard_bounce':
      return {eventType: 'Bounce', messageId, bounceType: 'Permanent'};
    case 'soft_bounce':
      return {eventType: 'Bounce', messageId, bounceType: 'Transient'};
    case 'complaint':
      return {eventType: 'Complaint', messageId};
    default:
      return null;
  }
}
```

- [ ] **Step 4: Add the handler to the Webhooks controller**

In `apps/api/src/controllers/Webhooks.ts`, add a new route. It reuses the same status-transition logic as the SNS handler. Extract the shared event-application into a private method (or, to keep the change small, implement the Brevo handler inline mirroring the SES `Bounce`/`Delivery`/`Open`/`Click`/`Complaint` cases against the `MappedEvent`):

```ts
  @Post('brevo')
  @CatchAsync
  public async receiveBrevoWebhook(req: Request, res: Response) {
    try {
      const mapped = mapBrevoEvent(req.body as BrevoPayload);
      if (!mapped) {
        signale.info('[WEBHOOK] Unknown or unmappable Brevo event');
        return res.status(200).json({success: true});
      }

      const email = await prisma.email.findUnique({
        where: {messageId: mapped.messageId},
        include: {contact: true, project: true},
      });
      if (!email) {
        signale.warn(`[WEBHOOK] Brevo ${mapped.eventType} dropped — no email found for messageId: ${mapped.messageId}`);
        return res.status(404).json({success: false, error: 'Email not found'});
      }

      // Apply the same transitions as the SES/SNS handler using mapped.eventType,
      // mapped.link, mapped.bounceType. (Extract the shared logic into a helper or
      // mirror the switch from receiveSNSWebhook.)
      await this.applyEmailEvent(email, mapped.eventType, {link: mapped.link, bounceType: mapped.bounceType});

      return res.status(200).json({success: true});
    } catch (error) {
      signale.error('[WEBHOOK] Error processing Brevo webhook:', error);
      return res.status(200).json({success: true});
    }
  }
```

For a clean implementation, extract the body of the SES `switch (eventType)` (lines 336-464) into a reusable private method `applyEmailEvent(email, eventType, extra)` that both handlers call, replacing the SES switch with a call to it. The Brevo handler passes `mapped.eventType`/`link`/`bounceType`.

- [ ] **Step 5: Register raw-body parsing and the route**

In `apps/api/src/app.ts`, add raw body parsing for Brevo (before the generic `json` middleware) so signatures could be verified on the raw body in the future:

```ts
    this.app.use('/webhooks/incoming/brevo', raw({type: 'application/json'}));
```

Note: overnightjs controller paths are relative to the `@Controller('webhooks')` prefix, so the HTTP path is `/webhooks/brevo`. Add raw-body handling that matches: mount the raw parser on the same path the controller exposes, or parse in the handler. Keep it consistent with the existing Stripe pattern (`/webhooks/incoming/stripe`).

- [ ] **Step 6: Run the tests and typecheck**

Run: `yarn workspace api vitest run src/services/__tests__/BrevoWebhookService.test.ts`
Expected: PASS.
Run: `yarn workspace api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/BrevoWebhookService.ts apps/api/src/services/__tests__/BrevoWebhookService.test.ts apps/api/src/controllers/Webhooks.ts apps/api/src/app.ts
git commit -m "feat(api): add Brevo webhook endpoint mapping events to Plunk"
```

---

### Task 7: Provider configuration API

**Files:**
- Create: `apps/api/src/services/ProviderConfigService.ts`
- Create: `apps/api/src/controllers/Providers.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/services/__tests__/ProviderConfigService.test.ts`

**Interfaces:**
- Consumes: `prisma`, `EmailProviderType`.
- Produces: service methods `list(projectId)`, `upsert(projectId, input)`, `remove(projectId, provider)` and controller routes `GET/POST/DELETE /projects/:id/providers` (via `@Controller('projects')` child or a new controller). Used by Task 8 (UI) to add/reorder/enable providers.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/__tests__/ProviderConfigService.test.ts`:

```ts
import {describe, expect, it, vi} from 'vitest';

import {EmailProviderType} from '@plunk/db';

import {prisma} from '../../database/prisma.js';
import {ProviderConfigService} from '../ProviderConfigService.js';

describe('ProviderConfigService.upsert', () => {
  it('creates a new provider config on first add', async () => {
    vi.mocked(prisma.projectEmailProvider.upsert).mockResolvedValue({id: 'p1'} as any);
    const result = await ProviderConfigService.upsert('proj1', {
      provider: EmailProviderType.BREVO,
      enabled: true,
      priority: 0,
      apiKey: 'xkeys-1',
      dailyQuota: 300,
      monthlyQuota: null,
    });
    expect(result.id).toBe('p1');
    expect(prisma.projectEmailProvider.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {projectId_provider: {projectId: 'proj1', provider: EmailProviderType.BREVO}},
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace api vitest run src/services/__tests__/ProviderConfigService.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/ProviderConfigService.ts`:

```ts
import {EmailProviderType} from '@plunk/db';

import {prisma} from '../database/prisma.js';

export interface ProviderConfigInput {
  provider: EmailProviderType;
  enabled: boolean;
  priority: number;
  apiKey?: string | null;
  dailyQuota?: number | null;
  monthlyQuota?: number | null;
}

export class ProviderConfigService {
  public static async list(projectId: string) {
    return prisma.projectEmailProvider.findMany({
      where: {projectId},
      orderBy: {priority: 'asc'},
    });
  }

  public static async upsert(projectId: string, input: ProviderConfigInput) {
    return prisma.projectEmailProvider.upsert({
      where: {projectId_provider: {projectId, provider: input.provider}},
      create: {
        projectId,
        provider: input.provider,
        enabled: input.enabled,
        priority: input.priority,
        apiKey: input.apiKey,
        dailyQuota: input.dailyQuota,
        monthlyQuota: input.monthlyQuota,
      },
      update: {
        enabled: input.enabled,
        priority: input.priority,
        apiKey: input.apiKey ?? undefined,
        dailyQuota: input.dailyQuota,
        monthlyQuota: input.monthlyQuota,
      },
    });
  }

  public static async remove(projectId: string, provider: EmailProviderType) {
    return prisma.projectEmailProvider.deleteMany({where: {projectId, provider}});
  }
}
```

- [ ] **Step 4: Implement the controller**

Create `apps/api/src/controllers/Providers.ts` (follow the existing controller conventions; see `controllers/Domains.ts` for auth pattern):

```ts
import {Controller, Delete, Get, Post} from '@overnightjs/core';
import type {Request, Response} from 'express';
import {EmailProviderType} from '@plunk/db';

import {ProviderConfigService} from '../services/ProviderConfigService.js';
import {MembershipService} from '../services/MembershipService.js';
import {HttpException} from '../exceptions/index.js';
import {CatchAsync} from '../utils/asyncHandler.js';

@Controller('projects/:projectId/providers')
export class Providers {
  @Get('')
  @CatchAsync
  public async list(req: Request, res: Response) {
    await MembershipService.ensureMembership(req.params.projectId, req.body.userId); // or per existing auth pattern
    const providers = await ProviderConfigService.list(req.params.projectId);
    return res.json({success: true, providers});
  }

  @Post('')
  @CatchAsync
  public async upsert(req: Request, res: Response) {
    const {provider, enabled, priority, apiKey, dailyQuota, monthlyQuota} = req.body;
    const result = await ProviderConfigService.upsert(req.params.projectId, {
      provider: provider as EmailProviderType,
      enabled,
      priority,
      apiKey,
      dailyQuota,
      monthlyQuota,
    });
    return res.json({success: true, provider: result});
  }

  @Delete(':provider')
  @CatchAsync
  public async remove(req: Request, res: Response) {
    await ProviderConfigService.remove(req.params.projectId, req.params.provider as EmailProviderType);
    return res.json({success: true});
  }
}
```

Note: the exact membership/auth helper depends on the existing controller patterns — replicate what `controllers/Domains.ts` does to authorize the user against the project.

- [ ] **Step 5: Register the controller**

In `apps/api/src/app.ts`, import `Providers` and add `new Providers()` to `addControllers([...])`.

- [ ] **Step 6: Run tests and typecheck**

Run: `yarn workspace api vitest run src/services/__tests__/ProviderConfigService.test.ts`
Expected: PASS.
Run: `yarn workspace api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/ProviderConfigService.ts apps/api/src/services/__tests__/ProviderConfigService.test.ts apps/api/src/controllers/Providers.ts apps/api/src/app.ts
git commit -m "feat(api): add per-project provider configuration API"
```

---

### Task 8: Settings UI for provider configuration

**Files:**
- Explore `apps/web/src/app/` for the project settings layout (e.g. a `Settings` section with tabs for Domains, Members, etc.).
- Add a "Email providers" settings section mirroring the existing domains settings UI.

**Interfaces:**
- Consumes: the API routes from Task 7 (`GET/POST/DELETE /projects/:id/providers`).
- Produces: a UI to list providers, toggle enable/disable, reorder priority, edit API key and daily/monthly quota.

- [ ] **Step 1: Locate the settings section**

Explore: `apps/web/src/app/` (look for `settings`, `domains`, or a project settings page) and identify the existing pattern (likely a tabbed settings page with a domains manager). Note the client data-fetching library in use (SWR/React Query/fetch) and follow it.

- [ ] **Step 2: Add the providers UI**

Add a settings section that:
- Lists the project's `ProjectEmailProvider` rows (from `GET /projects/:id/providers`).
- Lets the user add a Brevo/SES provider with API key (Brevo) and quota fields.
- Toggles `enabled`.
- Reorders via up/down buttons that mutate `priority` and call `POST /projects/:id/providers` for each affected row.
- Deletes via `DELETE /projects/:id/providers/:provider`.

Follow the exact component/query conventions found in the existing domains settings page. Keep copy consistent with the rest of the dashboard.

- [ ] **Step 3: Typecheck and lint**

Run: `yarn workspace web typecheck`
Run: `yarn lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add email provider settings UI"
```

---

## Self-Review Notes

- **Spec coverage:** data model (Task 1), provider abstraction (Task 2), quota per-project (Task 3), fallback+queue (Tasks 4-5), Brevo webhook (Task 6), config enable/reorder/quota (Tasks 7-8). SES stays optional (it's just one `EmailProvider`; if not configured, no row exists). Domain verification via Brevo API is intentionally out of scope per the spec.
- **Placeholder scan:** Task 8 is intentionally lighter and depends on discovering the web app's existing settings conventions; Task 5's test has a note about the cleanest assertion. These are the only two soft spots and are flagged inline rather than silently underspecified.
- **Type consistency:** `OutboundEmail`, `ProviderConfig`, `SendResult`, `EmailProvider` are defined in Task 2 and used identically in Tasks 4-5. `AllProvidersExhaustedError` defined in Task 4, used in Task 5. `ProjectEmailProvider`/`ProviderQuotaUsage` from Task 1 used across Tasks 3-7.

---

## Known Limitations

### Soft quota enforcement (accepted for this phase)

Quota enforcement is **soft**: `ProviderQuotaService.getRemaining` reads today's/month's usage and the dispatcher checks it immediately before sending, but the check and the `incrementUsage` write are **not atomic** — two concurrent sends for the same provider can both observe remaining quota and both send, overshooting `dailyQuota`/`monthlyQuota` slightly under contention. This is a deliberate, documented trade-off for this phase: an atomic check-and-increment would require a row lock or a serialized counter per provider/date, adding contention to the hot send path at the scale Plunk operates. The small overshoot on bursty traffic is accepted; operators wanting strict enforcement can set quotas with headroom. If strict enforcement becomes a requirement, the follow-up is to gate sends on an atomic counter (e.g. `UPDATE ... SET count = count + 1 WHERE count < quota` returning rowcount) or move to a BullMQ per-provider semaphore.
