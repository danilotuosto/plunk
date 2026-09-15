import type {EmailProviderType} from '@plunk/db';

export type ProviderType = EmailProviderType;

export interface OutboundEmail {
  from: {name: string; email: string};
  to: string[] | {name?: string; email: string}[];
  content: {subject: string; html: string};
  reply?: string;
  headers?: Record<string, string> | null;
  attachments?:
    | {
        filename: string;
        content: string;
        contentType: string;
        contentId?: string;
        disposition?: 'attachment' | 'inline';
      }[]
    | null;
  tracking?: boolean;
}

export interface SendResult {
  messageId: string;
}

export interface ProviderConfig {
  apiKey?: string | null;
  enabled: boolean;
}

export interface EmailProvider {
  readonly type: ProviderType;
  send(email: OutboundEmail, config: ProviderConfig): Promise<SendResult>;
}
