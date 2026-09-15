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
