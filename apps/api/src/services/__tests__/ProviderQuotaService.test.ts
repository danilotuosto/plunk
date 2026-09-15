import {describe, expect, it, vi} from 'vitest';

import {prisma} from '../../database/prisma.js';
import {ProviderQuotaService} from '../ProviderQuotaService.js';

vi.mock('../../database/prisma.js', () => ({
  prisma: {
    providerQuotaUsage: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

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
    vi.mocked(prisma.providerQuotaUsage.findUnique).mockResolvedValue({id: 'u', providerId: 'p1', date: new Date('2026-09-15'), count: 250} as any);
    vi.mocked(prisma.providerQuotaUsage.aggregate).mockResolvedValue({_sum: {count: 100}} as any);
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
