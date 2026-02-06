import Dexie, { type Table } from 'dexie';
import type { MessageEvent } from '../shared/message-normalizer';

export interface ConversationRecord {
  id: string;
  source: 'whatsapp_web';
  title: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type OutboxJobKind = 'summary' | 'report';
export type OutboxJobStatus = 'pending' | 'processing' | 'failed';

export interface OutboxJobRecord {
  id: string;
  kind: OutboxJobKind;
  payload: Record<string, unknown>;
  status: OutboxJobStatus;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  idempotencyKey: string;
  lastError?: string;
  remoteJobId?: string;
}

export interface MessageRecord extends MessageEvent {
  persistedAt: string;
}

export class WACopilotDb extends Dexie {
  conversations!: Table<ConversationRecord, string>;

  messages!: Table<MessageRecord, string>;

  outboxJobs!: Table<OutboxJobRecord, string>;

  constructor() {
    super('wa-copilot-db');
    this.version(1).stores({
      conversations: 'id, source, updatedAt, lastSyncedAt',
      messages:
        'eventId, conversationId, timestampSource, dedupeKey, [conversationId+timestampSource]',
      outboxJobs: 'id, kind, status, nextAttemptAt, createdAt',
    });
    this.version(2).stores({
      conversations: 'id, source, updatedAt, lastSyncedAt',
      messages:
        'eventId, conversationId, timestampSource, &dedupeKey, [conversationId+timestampSource], [conversationId+dedupeKey]',
      outboxJobs: 'id, kind, status, nextAttemptAt, createdAt',
    });
  }
}

export const db = new WACopilotDb();

export async function upsertConversation(
  id: string,
  title: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const existing = await db.conversations.get(id);

  if (!existing) {
    await db.conversations.add({
      id,
      source: 'whatsapp_web',
      title,
      lastSyncedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return;
  }

  await db.conversations.update(id, {
    title: title || existing.title,
    lastSyncedAt: nowIso,
    updatedAt: nowIso,
  });
}

export async function saveMessage(event: MessageEvent): Promise<boolean> {
  const message: MessageRecord = {
    ...event,
    persistedAt: new Date().toISOString(),
  };
  try {
    await db.messages.add(message);
    return true;
  } catch (error) {
    if (error instanceof Dexie.ConstraintError) {
      return false;
    }
    throw error;
  }
}

export async function listMessagesByConversation(
  conversationId: string,
  limit = 50,
): Promise<MessageRecord[]> {
  return db.messages
    .where('conversationId')
    .equals(conversationId)
    .reverse()
    .limit(limit)
    .toArray();
}

export async function countMessagesByConversation(
  conversationId: string,
): Promise<number> {
  return db.messages.where('conversationId').equals(conversationId).count();
}

export async function pruneOldData(ttlDays = 30): Promise<void> {
  const now = Date.now();
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const thresholdIso = new Date(now - ttlMs).toISOString();

  const staleMessages = await db.messages
    .where('timestampSource')
    .below(thresholdIso)
    .primaryKeys();
  if (staleMessages.length > 0) {
    await db.messages.bulkDelete(staleMessages);
  }

  const staleConversations = await db.conversations
    .where('updatedAt')
    .below(thresholdIso)
    .primaryKeys();
  if (staleConversations.length > 0) {
    await db.conversations.bulkDelete(staleConversations);
  }
}

export async function clearConversationData(
  conversationId: string,
): Promise<void> {
  await db.transaction(
    'rw',
    db.messages,
    db.conversations,
    db.outboxJobs,
    async () => {
      const messageKeys = await db.messages
        .where('conversationId')
        .equals(conversationId)
        .primaryKeys();
      if (messageKeys.length > 0) {
        await db.messages.bulkDelete(messageKeys);
      }

      await db.conversations.delete(conversationId);

      const jobs = await db.outboxJobs.toArray();
      const jobsToDelete = jobs
        .filter((job) => {
          const payloadConversation = (
            job.payload.conversation as { conversation_id?: string } | undefined
          )?.conversation_id;
          return payloadConversation === conversationId;
        })
        .map((job) => job.id);

      if (jobsToDelete.length > 0) {
        await db.outboxJobs.bulkDelete(jobsToDelete);
      }
    },
  );
}
