import {EmailProviderType} from '@plunk/db';

import {sendRawEmail} from '../SESService.js';
import type {EmailProvider, OutboundEmail, ProviderConfig, SendResult} from './types.js';

export class SESProvider implements EmailProvider {
  public readonly type = EmailProviderType.SES;

  public async send(email: OutboundEmail, _config: ProviderConfig): Promise<SendResult> {
    return sendRawEmail(email);
  }
}
