// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { WhatsappConversationObserver } from '../src/content/whatsapp-observer';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent ?? '';
    },
    set(value: string) {
      this.textContent = value;
    },
  });
});

function waitMutationCycle(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });
}

describe('whatsapp-observer', () => {
  it('captura mensagens e evita duplicidade por fingerprint', async () => {
    document.body.innerHTML = `
      <div class="message-in" data-id="msg-1">
        <div class="selectable-text copyable-text"><span>primeira mensagem</span></div>
      </div>
    `;

    const onMessage = vi.fn();
    const observer = new WhatsappConversationObserver({
      tenantId: 'default',
      getConversationId: () => 'wa:teste',
      onMessage,
    });

    observer.start();
    expect(onMessage).toHaveBeenCalledTimes(1);

    const duplicate = document.createElement('div');
    duplicate.className = 'message-in';
    duplicate.setAttribute('data-id', 'msg-1');
    duplicate.innerHTML =
      '<div class="selectable-text copyable-text"><span>primeira mensagem</span></div>';
    document.body.append(duplicate);

    await waitMutationCycle();
    expect(onMessage).toHaveBeenCalledTimes(1);

    const next = document.createElement('div');
    next.className = 'message-in';
    next.setAttribute('data-id', 'msg-2');
    next.innerHTML =
      '<div class="selectable-text copyable-text"><span>segunda mensagem</span></div>';
    document.body.append(next);

    await waitMutationCycle();
    expect(onMessage).toHaveBeenCalledTimes(2);
    observer.stop();
  });
});
