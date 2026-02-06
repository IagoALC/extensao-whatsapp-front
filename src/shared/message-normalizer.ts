export type MessageAuthorRole = 'self' | 'contact' | 'system';

export type MessageSource = 'whatsapp_web';

export interface MessageEvent {
  schemaVersion: string;
  tenantId: string;
  conversationId: string;
  eventId: string;
  source: MessageSource;
  sourceMessageId: string | null;
  authorRole: MessageAuthorRole;
  timestampSource: string;
  sequence: number;
  text: string;
  textNormalized: string;
  dedupeKey: string;
  checksum: string;
  ingestedAt: string;
}

export interface MessageEventInput {
  tenantId: string;
  conversationId: string;
  sourceMessageId?: string | null;
  authorRole: MessageAuthorRole;
  timestampSource?: string | null;
  sequence: number;
  text: string;
}

const SCHEMA_VERSION = '1.0.0';

export function normalizeMessageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hash32(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hash64(value: string): string {
  return `${hash32(value)}${hash32(`${value}:seed`)}`;
}

function normalizeDateInput(value: string | null | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return new Date().toISOString();
  }
  return new Date(parsed).toISOString();
}

export function parseTimestampFromPrePlainText(
  prePlainText: string | null,
): string | null {
  if (!prePlainText) {
    return null;
  }

  const match = prePlainText.match(
    /\[(\d{1,2}):(\d{2}),\s(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/,
  );
  if (!match) {
    return null;
  }

  const [, hour, minute, day, month, yearRaw] = match;
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  const localDate = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  if (Number.isNaN(localDate.getTime())) {
    return null;
  }
  return localDate.toISOString();
}

export function createMessageEvent(input: MessageEventInput): MessageEvent {
  const textNormalized = normalizeMessageText(input.text);
  const timestampSource = normalizeDateInput(input.timestampSource);
  const sourceMessageId = input.sourceMessageId ?? null;
  const dedupeSeed = sourceMessageId
    ? `${input.tenantId}:${input.conversationId}:${sourceMessageId}`
    : `${input.tenantId}:${input.conversationId}:${input.authorRole}:${timestampSource}:${textNormalized}`;

  const dedupeKey = hash64(dedupeSeed);
  const checksum = hash64(
    `${input.conversationId}:${sourceMessageId ?? 'none'}:${textNormalized}`,
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    eventId: crypto.randomUUID(),
    source: 'whatsapp_web',
    sourceMessageId,
    authorRole: input.authorRole,
    timestampSource,
    sequence: input.sequence,
    text: input.text,
    textNormalized,
    dedupeKey,
    checksum,
    ingestedAt: new Date().toISOString(),
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function isVisibleElement(element: Element): element is HTMLElement {
  const target = element as HTMLElement;
  return !!target.offsetParent || target.getClientRects().length > 0;
}

function normalizeTitleCandidate(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isLikelyConversationTitle(value: string): boolean {
  const normalized = normalizeTitleCandidate(value);
  if (!normalized) {
    return false;
  }

  const lowered = normalized.toLowerCase();
  const ignoredValues = new Set([
    'online',
    'typing...',
    'digitando...',
    'visto por ultimo',
    'last seen',
  ]);

  if (ignoredValues.has(lowered)) {
    return false;
  }

  return true;
}

function readConversationTitleFromDom(): string | null {
  const selectors = [
    '#main header span[title]',
    '#main [data-testid="conversation-info-header-chat-title"]',
    '#main header h1 span[dir="auto"]',
    '#main header h1 span',
    '#main header span[dir="auto"]',
    '#main header [role="button"] span',
  ];

  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    for (const node of nodes) {
      if (!isVisibleElement(node)) {
        continue;
      }

      const attrTitle = node.getAttribute('title')?.trim();
      if (attrTitle && isLikelyConversationTitle(attrTitle)) {
        return normalizeTitleCandidate(attrTitle);
      }

      const text = node.textContent?.trim();
      if (text && isLikelyConversationTitle(text)) {
        return normalizeTitleCandidate(text);
      }
    }
  }

  return null;
}

function hasVisibleConversationComposer(): boolean {
  const selectors = [
    '#main div[contenteditable="true"][data-tab]',
    '#main [role="textbox"][contenteditable="true"]',
    '#main footer div[contenteditable="true"][data-tab]',
    '#main footer [role="textbox"][contenteditable="true"]',
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node && isVisibleElement(node)) {
      return true;
    }
  }
  return false;
}

export function hasOpenConversation(): boolean {
  if (hasVisibleConversationComposer()) {
    return true;
  }

  const hasKnownTitle = !!readConversationTitleFromDom();
  if (!hasKnownTitle) {
    return false;
  }

  const hasMessageNodes = !!document.querySelector(
    '#main [data-id], #main .message-in, #main .message-out',
  );
  return hasMessageNodes;
}

export function getCurrentConversationTitle(): string {
  const title = readConversationTitleFromDom();
  if (title) {
    return title;
  }
  return 'Conversa atual';
}

export function getCurrentConversationId(): string {
  const url = new URL(window.location.href);
  const phone = url.searchParams.get('phone');
  if (phone) {
    return `wa:${phone}`;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  const pathHint = pathParts[pathParts.length - 1];
  if (pathHint && pathHint !== 'send') {
    return `wa:path:${slugify(pathHint)}`;
  }

  const title = readConversationTitleFromDom();
  if (title) {
    return `wa:title:${slugify(title)}`;
  }

  return 'wa:unknown';
}
