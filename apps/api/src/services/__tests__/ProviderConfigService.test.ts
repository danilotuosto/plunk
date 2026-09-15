import {describe, expect, it, vi} from 'vitest';

import {EmailProviderType} from '@plunk/db';

import {prisma} from '../../database/prisma.js';
import {ProviderConfigService} from '../ProviderConfigService.js';

vi.mock('../../database/prisma.js', () => ({
  prisma: {
    projectEmailProvider: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

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
