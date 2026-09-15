import {EmailProviderType} from '@plunk/db';

import type {ProviderType} from './types.js';
import {SESProvider} from './SESProvider.js';
import {BrevoProvider} from './BrevoProvider.js';

export * from './types.js';

export const sesProvider = new SESProvider();
export const brevoProvider = new BrevoProvider();

export function getProvider(type: ProviderType) {
  switch (type) {
    case EmailProviderType.SES:
      return sesProvider;
    case EmailProviderType.BREVO:
      return brevoProvider;
    default:
      throw new Error(`Unknown email provider type: ${type}`);
  }
}
