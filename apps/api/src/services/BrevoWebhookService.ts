export interface BrevoPayload {
  event?: string;
  'message-id'?: string;
  link?: string;
  [key: string]: unknown;
}

export interface MappedEvent {
  eventType: 'Delivery' | 'Open' | 'Click' | 'Bounce' | 'Complaint';
  messageId: string;
  link?: string;
  bounceType?: 'Permanent' | 'Transient';
}

export function mapBrevoEvent(payload: BrevoPayload): MappedEvent | null {
  const event = payload.event;
  const messageId = payload['message-id'];
  if (!messageId) return null;

  switch (event) {
    case 'delivered':
      return {eventType: 'Delivery', messageId};
    case 'opened':
      return {eventType: 'Open', messageId};
    case 'click':
      return {eventType: 'Click', messageId, link: payload.link};
    case 'hard_bounce':
      return {eventType: 'Bounce', messageId, bounceType: 'Permanent'};
    case 'soft_bounce':
      return {eventType: 'Bounce', messageId, bounceType: 'Transient'};
    case 'complaint':
      return {eventType: 'Complaint', messageId};
    default:
      return null;
  }
}
