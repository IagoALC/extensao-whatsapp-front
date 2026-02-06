import { describe, expect, it } from 'vitest';
import {
  createMessageEvent,
  normalizeMessageText,
  parseTimestampFromPrePlainText,
} from '../src/shared/message-normalizer';

describe('message-normalizer', () => {
  it('normaliza espacos no texto', () => {
    expect(normalizeMessageText('  Ola   mundo   ')).toBe('Ola mundo');
  });

  it('parseia timestamp do formato do WhatsApp', () => {
    const parsed = parseTimestampFromPrePlainText('[08:15, 05/02/2026] Fulano:');
    expect(parsed).toBeTruthy();
    expect(parsed?.startsWith('2026-02-05T')).toBe(true);
  });

  it('gera dedupe e checksum deterministas para a mesma origem', () => {
    const left = createMessageEvent({
      tenantId: 'acme',
      conversationId: 'wa:5511',
      sourceMessageId: 'MSG-1',
      authorRole: 'contact',
      timestampSource: '2026-02-05T20:00:00.000Z',
      sequence: 1,
      text: 'Status do pedido?',
    });

    const right = createMessageEvent({
      tenantId: 'acme',
      conversationId: 'wa:5511',
      sourceMessageId: 'MSG-1',
      authorRole: 'contact',
      timestampSource: '2026-02-05T20:00:00.000Z',
      sequence: 2,
      text: 'Status do pedido?',
    });

    expect(left.dedupeKey).toBe(right.dedupeKey);
    expect(left.checksum).toBe(right.checksum);
    expect(left.eventId).not.toBe(right.eventId);
  });
});
