import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/core/api-client';
import { LocalJobQueue } from '../src/core/job-queue';
import type { OutboxJobRecord, WACopilotDb } from '../src/storage/db';

class InMemoryOutboxTable {
  private readonly records = new Map<string, OutboxJobRecord>();

  async put(record: OutboxJobRecord): Promise<string> {
    this.records.set(record.id, { ...record });
    return record.id;
  }

  async update(
    id: string,
    changes: Partial<OutboxJobRecord>,
  ): Promise<number> {
    const current = this.records.get(id);
    if (!current) {
      return 0;
    }
    this.records.set(id, { ...current, ...changes });
    return 1;
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async toArray(): Promise<OutboxJobRecord[]> {
    return Array.from(this.records.values()).map((record) => ({ ...record }));
  }
}

function createFakeDb() {
  const table = new InMemoryOutboxTable();
  return {
    db: {
      outboxJobs: table,
    } as unknown as WACopilotDb,
    table,
  };
}

function createApiClientMock(overrides?: Partial<ApiClient>): ApiClient {
  const base: ApiClient = {
    createSuggestions: vi.fn(),
    enqueueSummary: vi.fn(async () => ({
      job_id: 'remote-summary-1',
      status: 'pending',
      status_url: '/v1/jobs/remote-summary-1',
    })),
    enqueueReport: vi.fn(async () => ({
      job_id: 'remote-report-1',
      status: 'pending',
      status_url: '/v1/jobs/remote-report-1',
    })),
    getJob: vi.fn(),
  } as unknown as ApiClient;

  return Object.assign(base, overrides);
}

describe('job-queue', () => {
  it('processa job com sucesso e remove da fila local', async () => {
    const { db, table } = createFakeDb();
    const apiClient = createApiClientMock();
    const queue = new LocalJobQueue({ db, apiClient });

    await queue.enqueue('summary', {
      conversation: {
        tenant_id: 'default',
        conversation_id: 'wa:1',
        channel: 'whatsapp_web',
      },
      summary_type: 'short',
    });

    await queue.flushDueJobs();
    const jobs = await table.toArray();
    expect(jobs).toHaveLength(0);
  });

  it('reagenda retry e marca como failed quando excede tentativas', async () => {
    const { db, table } = createFakeDb();
    const apiClient = createApiClientMock({
      enqueueSummary: vi.fn(async () => {
        throw new Error('backend down');
      }),
    });
    const queue = new LocalJobQueue({
      db,
      apiClient,
      maxAttempts: 2,
      retryBaseMs: 1,
    });

    await queue.enqueue('summary', {
      conversation: {
        tenant_id: 'default',
        conversation_id: 'wa:1',
        channel: 'whatsapp_web',
      },
      summary_type: 'short',
    });

    await queue.flushDueJobs();
    let jobs = await table.toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].attempts).toBe(1);

    await table.update(jobs[0].id, { nextAttemptAt: 0 });
    await queue.flushDueJobs();

    jobs = await table.toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].attempts).toBe(2);

    const retried = await queue.retryFailedJobs();
    expect(retried).toBe(1);
    jobs = await table.toArray();
    expect(jobs[0].status).toBe('pending');
  });
});
