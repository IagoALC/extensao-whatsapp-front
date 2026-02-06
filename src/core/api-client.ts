import { getRuntimeSettings } from './settings';

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

  private async request<TResponse>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    config?: {
      timeoutMs?: number;
      idempotencyKey?: string;
    },
  ): Promise<TResponse> {
    const controller = new AbortController();
    const timeoutMs = config?.timeoutMs ?? this.options.timeoutMs ?? 5000;
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    const headers: HeadersInit = {
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
      const response = await fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
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
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError(`Request timeout after ${timeoutMs}ms`, 504);
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
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
