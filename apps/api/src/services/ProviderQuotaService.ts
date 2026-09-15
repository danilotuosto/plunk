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
