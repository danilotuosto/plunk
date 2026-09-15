import {describe, expect, it} from 'vitest';

import {mapBrevoEvent} from '../BrevoWebhookService.js';

describe('mapBrevoEvent', () => {
  it('maps delivered', () => {
    expect(mapBrevoEvent({event: 'delivered', 'message-id': 'm1'})).toEqual({eventType: 'Delivery', messageId: 'm1', link: undefined});
  });
  it('maps opened', () => {
    expect(mapBrevoEvent({event: 'opened', 'message-id': 'm1'})).toEqual({eventType: 'Open', messageId: 'm1', link: undefined});
  });
  it('maps click with link', () => {
    expect(mapBrevoEvent({event: 'click', 'message-id': 'm1', link: 'https://x.com'})).toEqual({eventType: 'Click', messageId: 'm1', link: 'https://x.com'});
  });
  it('maps hard_bounce to permanent Bounce', () => {
    expect(mapBrevoEvent({event: 'hard_bounce', 'message-id': 'm1'})).toEqual({eventType: 'Bounce', messageId: 'm1', bounceType: 'Permanent', link: undefined});
  });
  it('maps soft_bounce to transient Bounce', () => {
    expect(mapBrevoEvent({event: 'soft_bounce', 'message-id': 'm1'})).toEqual({eventType: 'Bounce', messageId: 'm1', bounceType: 'Transient', link: undefined});
  });
  it('maps complaint', () => {
    expect(mapBrevoEvent({event: 'complaint', 'message-id': 'm1'})).toEqual({eventType: 'Complaint', messageId: 'm1', link: undefined});
  });
  it('returns null for unknown events', () => {
    expect(mapBrevoEvent({event: 'blocked', 'message-id': 'm1'})).toBeNull();
  });
});
