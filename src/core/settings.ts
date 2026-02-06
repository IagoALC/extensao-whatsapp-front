import browser from 'webextension-polyfill';

// API settings are intentionally code-driven (not user-editable in UI).
const CONSENT_SYNC_KEY = 'consentGranted';
const ENV = import.meta.env as Record<string, string | boolean | undefined>;

function readEnvValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = ENV[key];
    if (typeof raw !== 'string') {
      continue;
    }
    const value = raw.trim();
    if (value.length > 0) {
      return value;
    }
  }
  return undefined;
}

const API_BASE_URL = normalizeBaseUrl(
  readEnvValue('WXT_API_BASE_URL', 'VITE_API_BASE_URL') ??
    'http://localhost:8080',
);
const API_AUTH_TOKEN =
  readEnvValue('WXT_API_AUTH_TOKEN', 'VITE_API_AUTH_TOKEN') ?? 'dev-token';

export interface RuntimeSettings {
  apiBaseUrl: string;
  apiAuthToken: string;
  consentGranted: boolean;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  const syncValues = await browser.storage.sync.get([CONSENT_SYNC_KEY]);

  return {
    apiBaseUrl: API_BASE_URL,
    apiAuthToken: API_AUTH_TOKEN,
    consentGranted: syncValues.consentGranted === true,
  };
}

export async function setConsentGranted(value: boolean): Promise<void> {
  await browser.storage.sync.set({ consentGranted: value });
}

export { API_BASE_URL, API_AUTH_TOKEN };
