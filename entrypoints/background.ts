import browser from 'webextension-polyfill';

interface ApiBridgeRequest {
  type: 'wa-copilot:api-request';
  payload: {
    baseUrl: string;
    path: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  };
}

interface ApiBridgeResponse {
  type: 'wa-copilot:api-response';
  ok: boolean;
  status: number;
  body?: unknown;
  networkError?: string;
}

function isApiBridgeRequest(value: unknown): value is ApiBridgeRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const typed = value as Partial<ApiBridgeRequest>;
  return typed.type === 'wa-copilot:api-request' && !!typed.payload;
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

async function handleApiBridgeRequest(
  request: ApiBridgeRequest,
): Promise<ApiBridgeResponse> {
  const { baseUrl, path, method, headers, body, timeoutMs } = request.payload;
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const parsedBody = await readJsonSafe(response);
    return {
      type: 'wa-copilot:api-response',
      ok: response.ok,
      status: response.status,
      body: parsedBody,
    };
  } catch (error) {
    const networkError =
      error instanceof Error ? error.message : 'network request failed';
    return {
      type: 'wa-copilot:api-response',
      ok: false,
      status: 0,
      networkError,
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    const sync = await browser.storage.sync.get(['consentGranted']);
    if (typeof sync.consentGranted !== 'boolean') {
      await browser.storage.sync.set({ consentGranted: false });
    }
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isApiBridgeRequest(message)) {
      return undefined;
    }
    return handleApiBridgeRequest(message);
  });
});
