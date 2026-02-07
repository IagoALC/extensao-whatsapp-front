// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCurrentConversationId,
  hasOpenConversation,
} from '../src/shared/message-normalizer';

describe('conversation detection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');
  });

  it('extrai JID do data-id da mensagem para identificar conversa atual', () => {
    document.body.innerHTML = `
      <div id="main">
        <div data-id="false_5511987654321@c.us_3EB0A1B2C3">
          <span>Teste</span>
        </div>
      </div>
    `;

    expect(getCurrentConversationId()).toBe('wa:jid:5511987654321@c.us');
  });

  it('retorna unknown quando nao encontra sinal de conversa', () => {
    expect(getCurrentConversationId()).toBe('wa:unknown');
  });

  it('considera conversa aberta quando ha mensagens com data-id mesmo sem composer', () => {
    document.body.innerHTML = `
      <div id="main">
        <div data-id="true_5511888888888@c.us_3EAAAA">
          <span>Mensagem</span>
        </div>
      </div>
    `;

    expect(hasOpenConversation()).toBe(true);
  });
});
