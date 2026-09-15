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
