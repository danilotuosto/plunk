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
