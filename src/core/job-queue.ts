import type { ApiClient, ReportRequest, SummaryRequest } from './api-client';
import {
  type OutboxJobKind,
  type OutboxJobRecord,
  type WACopilotDb,
} from '../storage/db';

type QueueEventType = 'enqueued' | 'completed' | 'retry_scheduled' | 'failed';

export interface QueueEvent {
  type: QueueEventType;
  jobId: string;
  kind: OutboxJobKind;
  remoteJobId?: string;
  error?: string;
  nextAttemptAt?: number;
}

export interface JobQueueOptions {
  db: WACopilotDb;
  apiClient: ApiClient;
  retryBaseMs?: number;
  maxAttempts?: number;
}

export interface QueueStats {
  pending: number;
  processing: number;
  failed: number;
}

function createIdempotencyKey(prefix = 'wa'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export class LocalJobQueue {
  private apiClient: ApiClient;

  private readonly retryBaseMs: number;

  private readonly maxAttempts: number;

  private readonly listeners = new Set<(event: QueueEvent) => void>();

  private timerId: number | null = null;

  private isFlushing = false;

  constructor(private readonly options: JobQueueOptions) {
    this.apiClient = options.apiClient;
    this.retryBaseMs = options.retryBaseMs ?? 1500;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  setApiClient(apiClient: ApiClient): void {
    this.apiClient = apiClient;
  }

  start(intervalMs = 2500): void {
    if (this.timerId !== null) {
      return;
    }
    this.timerId = window.setInterval(() => {
      void this.flushDueJobs();
    }, intervalMs);
  }

  stop(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  subscribe(listener: (event: QueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async enqueue(
    kind: OutboxJobKind,
    payload: SummaryRequest | ReportRequest,
    idempotencyKey?: string,
  ): Promise<OutboxJobRecord> {
    const now = Date.now();
    const job: OutboxJobRecord = {
      id: crypto.randomUUID(),
      kind,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: idempotencyKey ?? createIdempotencyKey(kind),
    };

    await this.options.db.outboxJobs.put(job);
    this.emit({
      type: 'enqueued',
      jobId: job.id,
      kind: job.kind,
    });
    return job;
  }

  async flushDueJobs(): Promise<void> {
    if (this.isFlushing) {
      return;
    }

    this.isFlushing = true;
    try {
      const now = Date.now();
      const jobs = (await this.options.db.outboxJobs.toArray())
        .filter((job) => job.status === 'pending' && job.nextAttemptAt <= now)
        .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);

      for (const job of jobs) {
        await this.processJob(job);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  async getStats(): Promise<QueueStats> {
    const jobs = await this.options.db.outboxJobs.toArray();
    return {
      pending: jobs.filter((job) => job.status === 'pending').length,
      processing: jobs.filter((job) => job.status === 'processing').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
    };
  }

  async retryFailedJobs(): Promise<number> {
    const failedJobs = (await this.options.db.outboxJobs.toArray()).filter(
      (job) => job.status === 'failed',
    );
    if (failedJobs.length === 0) {
      return 0;
    }

    const now = Date.now();
    for (const job of failedJobs) {
      await this.options.db.outboxJobs.update(job.id, {
        status: 'pending',
        nextAttemptAt: now,
        updatedAt: now,
      });
    }
    return failedJobs.length;
  }

  private async processJob(job: OutboxJobRecord): Promise<void> {
    await this.options.db.outboxJobs.update(job.id, {
      status: 'processing',
      updatedAt: Date.now(),
    });

    try {
      const remoteJobId = await this.dispatchRemoteJob(job);
      await this.options.db.outboxJobs.delete(job.id);
      this.emit({
        type: 'completed',
        jobId: job.id,
        kind: job.kind,
        remoteJobId,
      });
    } catch (error) {
      const attempts = job.attempts + 1;
      const normalized = this.normalizeError(error);
      const permanentFailure =
        attempts >= this.maxAttempts || normalized.retryable === false;

      if (permanentFailure) {
        await this.options.db.outboxJobs.update(job.id, {
          attempts,
          status: 'failed',
          updatedAt: Date.now(),
          lastError: normalized.message,
        });
        this.emit({
          type: 'failed',
          jobId: job.id,
          kind: job.kind,
          error: normalized.message,
        });
        return;
      }

      const nextAttemptAt = Date.now() + this.computeBackoffMs(attempts);
      await this.options.db.outboxJobs.update(job.id, {
        attempts,
        status: 'pending',
        nextAttemptAt,
        updatedAt: Date.now(),
        lastError: normalized.message,
      });
      this.emit({
        type: 'retry_scheduled',
        jobId: job.id,
        kind: job.kind,
        error: normalized.message,
        nextAttemptAt,
      });
    }
  }

  private async dispatchRemoteJob(job: OutboxJobRecord): Promise<string> {
    if (job.kind === 'summary') {
      const response = await this.apiClient.enqueueSummary(
        job.payload as unknown as SummaryRequest,
        job.idempotencyKey,
      );
      return response.job_id;
    }

    const response = await this.apiClient.enqueueReport(
      job.payload as unknown as ReportRequest,
      job.idempotencyKey,
    );
    return response.job_id;
  }

  private computeBackoffMs(attempts: number): number {
    const exponential = this.retryBaseMs * 2 ** (attempts - 1);
    const jitter = Math.floor(Math.random() * 500);
    return exponential + jitter;
  }

  private normalizeError(error: unknown): {
    message: string;
    retryable: boolean;
  } {
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      'retryable' in error
    ) {
      const maybeRetryable = (error as { retryable?: unknown }).retryable;
      return {
        message: `${String((error as { message?: unknown }).message ?? 'error')}`,
        retryable: typeof maybeRetryable === 'boolean' ? maybeRetryable : true,
      };
    }

    if (error instanceof Error) {
      return {
        message: error.message,
        retryable: true,
      };
    }

    return {
      message: 'unknown_error',
      retryable: true,
    };
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
