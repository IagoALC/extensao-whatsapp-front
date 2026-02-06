// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LocalJobQueue } from '../../src/core/job-queue';
import type { ApiClient } from '../../src/core/api-client';
import type { OutboxJobRecord, WACopilotDb } from '../../src/storage/db';
import SendGuard from '../../src/ui/sidebar/SendGuard';

class InMemoryOutboxTable {
  private readonly records = new Map<string, OutboxJobRecord>();

  async put(record: OutboxJobRecord): Promise<string> {
    this.records.set(record.id, { ...record });
    return record.id;
  }

  async update(id: string, changes: Partial<OutboxJobRecord>): Promise<number> {
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

function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function createApiClientMock(overrides?: Partial<ApiClient>): ApiClient {
  const base: ApiClient = {
    createSuggestions: vi.fn(),
    enqueueSummary: vi.fn(async () => ({
      job_id: 'summary-job',
      status: 'pending',
      status_url: '/v1/jobs/summary-job',
    })),
    enqueueReport: vi.fn(async () => ({
      job_id: 'report-job',
      status: 'pending',
      status_url: '/v1/jobs/report-job',
    })),
    getJob: vi.fn(),
  } as unknown as ApiClient;
  return Object.assign(base, overrides);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('e2e workflows', () => {
  it('cobre resumo e relatorio com fila local e falha de rede com retry', async () => {
    const { db, table } = createFakeDb();
    const summaryApi = createApiClientMock({
      enqueueSummary: vi
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({
          job_id: 'summary-job-ok',
          status: 'pending',
          status_url: '/v1/jobs/summary-job-ok',
        }),
    });
    const summaryQueue = new LocalJobQueue({
      db,
      apiClient: summaryApi,
      retryBaseMs: 1,
      maxAttempts: 2,
    });

    await summaryQueue.enqueue('summary', {
      conversation: {
        tenant_id: 'default',
        conversation_id: 'chat-summary',
        channel: 'whatsapp_web',
      },
      summary_type: 'short',
      include_actions: true,
    });

    await summaryQueue.flushDueJobs();
    let jobs = await table.toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].attempts).toBe(1);

    await table.update(jobs[0].id, { nextAttemptAt: 0 });
    await summaryQueue.flushDueJobs();
    expect(await table.toArray()).toHaveLength(0);

    const { db: reportDb, table: reportTable } = createFakeDb();
    const reportQueue = new LocalJobQueue({
      db: reportDb,
      apiClient: createApiClientMock(),
      retryBaseMs: 1,
      maxAttempts: 2,
    });
    await reportQueue.enqueue('report', {
      conversation: {
        tenant_id: 'default',
        conversation_id: 'chat-report',
        channel: 'whatsapp_web',
      },
      report_type: 'timeline',
      page: 1,
      page_size: 20,
    });
    await reportQueue.flushDueJobs();
    expect(await reportTable.toArray()).toHaveLength(0);
  });

  it('cobre HITL no guard de envio (confirmacao dupla antes de acao)', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    let root: Root | null = createRoot(mount);

    const onCopy = vi.fn(async () => {});
    const onInsert = vi.fn(async () => {});

    root?.render(
      React.createElement(SendGuard, {
        onCopy,
        onInsert,
      }),
    );
    await nextTick();

    const buttons = mount.querySelectorAll('button');
    const copyButton = buttons.item(0);
    expect(copyButton).toBeTruthy();
    expect(buttons.item(1)).toBeTruthy();

    copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(onCopy).toHaveBeenCalledTimes(0);

    copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledTimes(0);

    root?.unmount();
    root = null;
    mount.remove();
  });
});
