import {EmailProviderType} from '@plunk/db';
import type {ProjectEmailProvider} from '@plunk/db';
import useSWR from 'swr';

import {network} from '../network';

export interface ProviderUpsertInput {
  provider: EmailProviderType;
  enabled: boolean;
  priority: number;
  apiKey?: string | null;
  dailyQuota?: number | null;
  monthlyQuota?: number | null;
}

/**
 * Hook to fetch the email providers configured for a project, ordered by priority.
 */
export function useProviders(projectId: string | undefined) {
  const {data, error, mutate, isLoading} = useSWR<ProjectEmailProvider[]>(
    projectId ? `/projects/${projectId}/providers` : null,
  );

  return {
    providers: data,
    error,
    isLoading,
    mutate,
  };
}

/**
 * Hook to create or update a provider config for a project.
 */
export function useUpsertProvider() {
  const upsert = async (projectId: string, input: ProviderUpsertInput) => {
    return network.fetch<{success: boolean; provider: ProjectEmailProvider}>(
      'POST',
      `/projects/${projectId}/providers`,
      input as Parameters<typeof network.fetch>[2],
    );
  };

  return {upsert};
}

/**
 * Hook to remove a provider config from a project.
 */
export function useRemoveProvider() {
  const remove = async (projectId: string, provider: EmailProviderType) => {
    return network.fetch<{success: boolean}>('DELETE', `/projects/${projectId}/providers/${provider}`);
  };

  return {remove};
}
