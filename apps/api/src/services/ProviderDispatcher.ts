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
    // Not a hard failure — re-queueing lets the project's provider configuration
    // catch up (a backfill may not have run, or an admin is mid-reconfiguration).
    signale.warn(`[DISPATCHER] Project ${projectId} has no enabled email providers configured, re-queueing`);
    throw new AllProvidersExhaustedError();
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
