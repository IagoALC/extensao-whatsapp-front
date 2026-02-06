import {
  createMessageEvent,
  parseTimestampFromPrePlainText,
  type MessageAuthorRole,
  type MessageEvent,
} from '../shared/message-normalizer';

const MESSAGE_SELECTOR = '[data-id], .message-in, .message-out';
const MAX_SEEN_KEYS = 6000;

export interface WhatsappObserverOptions {
  tenantId: string;
  getConversationId: () => string;
  onMessage: (event: MessageEvent) => void | Promise<void>;
  logger?: (message: string, details?: unknown) => void;
}

export class WhatsappConversationObserver {
  private readonly seenKeys = new Set<string>();

  private readonly sequenceByConversation = new Map<string, number>();

  private observer: MutationObserver | null = null;

  private started = false;

  constructor(private readonly options: WhatsappObserverOptions) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.bootstrapExistingMessages();

    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const addedNode of mutation.addedNodes) {
          this.processNode(addedNode);
        }
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    this.started = true;
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.started = false;
  }

  private bootstrapExistingMessages(): void {
    const nodes = document.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR);
    for (const node of nodes) {
      this.handleMessageElement(node);
    }
  }

  private processNode(node: Node): void {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    if (node.matches(MESSAGE_SELECTOR)) {
      this.handleMessageElement(node);
    }

    const nestedNodes = node.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR);
    for (const nestedNode of nestedNodes) {
      this.handleMessageElement(nestedNode);
    }
  }

  private handleMessageElement(element: HTMLElement): void {
    try {
      const text = this.extractMessageText(element);
      if (!text) {
        return;
      }

      const conversationId = this.options.getConversationId();
      if (!conversationId) {
        return;
      }

      const sourceMessageId = element.getAttribute('data-id');
      const prePlainText = element.getAttribute('data-pre-plain-text');
      const authorRole = this.inferAuthorRole(element);
      const timestampFromSource = parseTimestampFromPrePlainText(prePlainText);
      const dedupeFingerprint = sourceMessageId
        ? `${conversationId}:${sourceMessageId}`
        : `${conversationId}:${authorRole}:${timestampFromSource ?? ''}:${text}`;

      if (this.seenKeys.has(dedupeFingerprint)) {
        return;
      }

      this.seenKeys.add(dedupeFingerprint);
      if (this.seenKeys.size > MAX_SEEN_KEYS) {
        const oldest = this.seenKeys.values().next().value as string | undefined;
        if (oldest) {
          this.seenKeys.delete(oldest);
        }
      }

      const event = createMessageEvent({
        tenantId: this.options.tenantId,
        conversationId,
        sourceMessageId,
        authorRole,
        timestampSource: timestampFromSource,
        sequence: this.nextSequence(conversationId),
        text,
      });

      void this.options.onMessage(event);
    } catch (error) {
      this.options.logger?.('failed_to_process_message_node', error);
    }
  }

  private extractMessageText(element: HTMLElement): string {
    const directText = element
      .querySelector<HTMLElement>('.selectable-text.copyable-text span')
      ?.innerText?.trim();
    if (directText) {
      return directText;
    }

    const textSpans = element.querySelectorAll<HTMLElement>(
      '.selectable-text.copyable-text span',
    );
    if (textSpans.length > 0) {
      const joined = Array.from(textSpans)
        .map((span) => span.innerText.trim())
        .filter(Boolean)
        .join(' ');
      if (joined) {
        return joined;
      }
    }

    return '';
  }

  private inferAuthorRole(element: HTMLElement): MessageAuthorRole {
    if (element.closest('.message-out')) {
      return 'self';
    }
    if (element.closest('.message-in')) {
      return 'contact';
    }
    return 'system';
  }

  private nextSequence(conversationId: string): number {
    const current = this.sequenceByConversation.get(conversationId) ?? 0;
    const next = current + 1;
    this.sequenceByConversation.set(conversationId, next);
    return next;
  }
}
