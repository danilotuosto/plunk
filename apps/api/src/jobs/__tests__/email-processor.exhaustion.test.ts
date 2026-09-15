import {beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailSourceType, EmailStatus} from '@plunk/db';

import {prisma} from '../../database/prisma.js';

vi.mock('../../database/prisma.js', () => ({
  prisma: {
    email: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

// Keep the real AllProvidersExhaustedError class (for `instanceof`), but stub the
// actual send so the test can force the exhaustion path deterministically.
vi.mock('../../services/ProviderDispatcher.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/ProviderDispatcher.js')>('../../services/ProviderDispatcher.js');
  return {...actual, sendEmailWithFallback: vi.fn()};
});

// Avoid loading the real SecurityService (network + Redis deps); phishing must not
// run in this unit test.
vi.mock('../../services/SecurityService.js', () => ({
  SecurityService: {
    checkPhishingContent: vi.fn().mockResolvedValue({isPhishing: false, confidence: 0, shouldDisable: false}),
    disableProjectForPhishing: vi.fn(),
  },
}));

import {AllProvidersExhaustedError, sendEmailWithFallback} from '../../services/ProviderDispatcher.js';
import {emailQueue} from '../../services/QueueService.js';
import {processEmailJob} from '../email-processor.js';

const baseEmail = {
  id: 'e1',
  projectId: 'p1',
  status: EmailStatus.PENDING,
  subject: 'S',
  body: '<p>x</p>',
  from: 'a@x.com',
  fromName: 'A',
  toName: null,
  replyTo: null,
  headers: null,
  attachments: null,
  sourceType: EmailSourceType.TRANSACTIONAL,
  contact: {id: 'c1', email: 'c@x.com', data: {}},
  project: {disabled: false, name: 'P', tracking: 'ENABLED', customer: null},
  template: null,
  campaign: null,
} as any;

describe('processEmailJob exhaustion handling', () => {
  let addSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.email.findUnique).mockResolvedValue(baseEmail);
    vi.mocked(sendEmailWithFallback).mockRejectedValue(new AllProvidersExhaustedError());
    addSpy = vi.spyOn(emailQueue, 'add').mockResolvedValue(undefined as any);
  });

  it('re-queues with a delay instead of failing when all providers are exhausted', async () => {
    await expect(processEmailJob({data: {emailId: 'e1'}} as any)).resolves.toBeUndefined();

    // Status is returned to PENDING so a later job can retry it.
    expect(prisma.email.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {id: 'e1'},
        data: {status: EmailStatus.PENDING},
      }),
    );

    // The job is re-queued (via QueueService.queueEmail → emailQueue.add) with a
    // bounded backoff delay and a UNIQUE jobId — reusing `email-e1` would dedupe
    // against the still-active job and never schedule the retry.
    expect(addSpy).toHaveBeenCalledWith(
      'send-email',
      {emailId: 'e1', attempt: 1},
      expect.objectContaining({
        delay: 60 * 1000,
        jobId: expect.stringMatching(/^email-e1-retry-0-\d+$/),
      }),
    );
  });

  it('uses exponential backoff and carries the attempt counter forward', async () => {
    await expect(processEmailJob({data: {emailId: 'e1', attempt: 2}} as any)).resolves.toBeUndefined();

    // attempt=2 → delay = min(60s * 2^2, 1h) = 4 minutes.
    expect(addSpy).toHaveBeenCalledWith(
      'send-email',
      {emailId: 'e1', attempt: 3},
      expect.objectContaining({delay: 4 * 60 * 1000}),
    );
  });

  it('gives up (FAILED with a clear error) after the retry cap is reached', async () => {
    await expect(processEmailJob({data: {emailId: 'e1', attempt: 10}} as any)).resolves.toBeUndefined();

    // No further requeue once the cap is hit.
    expect(addSpy).not.toHaveBeenCalled();

    // Marked FAILED with an explicit message so it is not silently dropped.
    expect(prisma.email.update).toHaveBeenCalledWith({
      where: {id: 'e1'},
      data: {status: EmailStatus.FAILED, error: 'All email providers exhausted after 10 attempts'},
    });
  });
});
