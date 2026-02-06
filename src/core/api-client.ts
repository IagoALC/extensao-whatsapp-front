import { getRuntimeSettings } from './settings';
import browser from 'webextension-polyfill';

export type Tone = 'formal' | 'neutro' | 'amigavel';

const SUGGESTIONS_TIMEOUT_MS = 20000;

export interface ConversationRef {
  tenant_id: string;
  conversation_id: string;
  channel: 'whatsapp_web';
}

export interface SuggestionRequest {
  conversation: ConversationRef;
  locale: string;
  tone: Tone;
  context_window: number;
  messages?: string[];
  max_candidates?: number;
  include_last_user_message?: boolean;
}

export interface SummaryRequest {
  conversation: ConversationRef;
  summary_type: 'short' | 'full';
  include_actions?: boolean;
}

export interface ReportRequest {
  conversation: ConversationRef;
  report_type: 'timeline' | 'temas' | 'atendimento';
  topic_filter?: string;
  page?: number;
  page_size?: number;
}

export interface SuggestionResponse {
  request_id: string;
  model_id: string;
  prompt_version: string;
  quality_score?: number;
  hitl_required?: boolean;
  hitl?: {
    required: boolean;
    allowed_actions: string[];
    prohibited_actions: string[];
    reason: string;
  };
  suggestions: Array<{
    rank: number;
    content: string;
    rationale?: string;
  }>;
}

export interface JobAcceptedResponse {
  job_id: string;
  status: 'pending';
  status_url: string;
  accepted_at?: string;
}

export interface JobStatusResponse {
  job_id: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  kind?: 'summary' | 'report';
  updated_at?: string;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

export interface ApiClientOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
}

export class ApiError extends Error {
  readonly status: number;

  readonly body?: unknown;

  readonly retryable: boolean;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

export function createIdempotencyKey(prefix = 'wa'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.replace(/\/+$/, '');
}

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private async requestViaBackground(
    path: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{
    ok: boolean;
    status: number;
    body?: unknown;
    networkError?: string;
  }> {
    return browser.runtime.sendMessage({
      type: 'wa-copilot:api-request',
      payload: {
        baseUrl: this.options.baseUrl,
        path,
        method,
        headers,
        body,
        timeoutMs,
      },
    }) as Promise<{
      ok: boolean;
      status: number;
      body?: unknown;
      networkError?: string;
    }>;
  }

  private async request<TResponse>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    config?: {
      timeoutMs?: number;
      idempotencyKey?: string;
    },
  ): Promise<TResponse> {
    const timeoutMs = config?.timeoutMs ?? this.options.timeoutMs ?? 5000;

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    if (config?.idempotencyKey) {
      headers['Idempotency-Key'] = config.idempotencyKey;
    }

    if (this.options.authToken) {
      headers.Authorization = `Bearer ${this.options.authToken}`;
    }

    try {
      const serializedBody = body ? JSON.stringify(body) : undefined;
      let transportResult:
        | {
            ok: boolean;
            status: number;
            body?: unknown;
            networkError?: string;
          }
        | undefined;

      try {
        transportResult = await this.requestViaBackground(
          path,
          method,
          headers,
          serializedBody,
          timeoutMs,
        );
      } catch {
        transportResult = undefined;
      }

      if (!transportResult) {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${this.options.baseUrl}${path}`, {
            method,
            headers,
            body: serializedBody,
            signal: controller.signal,
          });
          const parsedBody = await readJsonSafe(response);
          if (!response.ok) {
            throw new ApiError(
              `HTTP ${response.status} on ${method} ${path}`,
              response.status,
              parsedBody,
            );
          }
          return parsedBody as TResponse;
        } finally {
          window.clearTimeout(timeoutId);
        }
      }

      if (transportResult.networkError) {
        throw new Error(transportResult.networkError);
      }
      if (!transportResult.ok) {
        throw new ApiError(
          `HTTP ${transportResult.status} on ${method} ${path}`,
          transportResult.status,
          transportResult.body,
        );
      }

      return transportResult.body as TResponse;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError(`Request timeout after ${timeoutMs}ms`, 504);
      }
      throw error;
    }
  }

  async createSuggestions(
    payload: SuggestionRequest,
  ): Promise<SuggestionResponse> {
    return this.request<SuggestionResponse>('/v1/suggestions', 'POST', payload, {
      timeoutMs: SUGGESTIONS_TIMEOUT_MS,
    });
  }

  async enqueueSummary(
    payload: SummaryRequest,
    idempotencyKey: string,
  ): Promise<JobAcceptedResponse> {
    return this.request<JobAcceptedResponse>('/v1/summaries', 'POST', payload, {
      timeoutMs: 900,
      idempotencyKey,
    });
  }

  async enqueueReport(
    payload: ReportRequest,
    idempotencyKey: string,
  ): Promise<JobAcceptedResponse> {
    return this.request<JobAcceptedResponse>('/v1/reports', 'POST', payload, {
      timeoutMs: 900,
      idempotencyKey,
    });
  }

  async getJob(jobId: string): Promise<JobStatusResponse> {
    return this.request<JobStatusResponse>(`/v1/jobs/${jobId}`, 'GET', undefined, {
      timeoutMs: 2000,
    });
  }
}

export async function createApiClient(): Promise<ApiClient> {
  const settings = await getRuntimeSettings();

  return new ApiClient({
    baseUrl: normalizeBaseUrl(settings.apiBaseUrl),
    authToken: settings.apiAuthToken,
  });
}
