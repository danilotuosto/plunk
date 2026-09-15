import {describe, expect, it, vi} from 'vitest';

import {EmailProviderType} from '@plunk/db';

import {prisma} from '../../database/prisma.js';
import {ProviderQuotaService} from '../ProviderQuotaService.js';
import {AllProvidersExhaustedError, sendEmailWithFallback} from '../ProviderDispatcher.js';
import {getProvider} from '../providers/index.js';

vi.mock('../../database/prisma.js', () => ({
  prisma: {
    projectEmailProvider: {
      findMany: vi.fn(),
    },
    providerQuotaUsage: {
      upsert: vi.fn(),
    },
  },
}));

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
