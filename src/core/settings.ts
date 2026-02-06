import browser from 'webextension-polyfill';

const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const SYNC_KEYS = ['apiBaseUrl', 'consentGranted'];
const LOCAL_KEYS = ['apiAuthToken'];

export interface RuntimeSettings {
  apiBaseUrl: string;
  apiAuthToken: string;
  consentGranted: boolean;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function toOriginPattern(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  const [syncValues, localValues] = await Promise.all([
    browser.storage.sync.get(SYNC_KEYS),
    browser.storage.local.get(LOCAL_KEYS),
  ]);

  const baseUrlRaw =
    typeof syncValues.apiBaseUrl === 'string' && syncValues.apiBaseUrl.length > 0
      ? syncValues.apiBaseUrl
      : DEFAULT_API_BASE_URL;

  return {
    apiBaseUrl: normalizeBaseUrl(baseUrlRaw),
    apiAuthToken:
      typeof localValues.apiAuthToken === 'string' ? localValues.apiAuthToken : '',
    consentGranted: syncValues.consentGranted === true,
  };
}

export async function setConsentGranted(value: boolean): Promise<void> {
  await browser.storage.sync.set({ consentGranted: value });
}

export async function saveApiSettings(
  baseUrl: string,
  apiAuthToken: string,
): Promise<void> {
  await Promise.all([
    browser.storage.sync.set({ apiBaseUrl: normalizeBaseUrl(baseUrl) }),
    browser.storage.local.set({ apiAuthToken: apiAuthToken.trim() }),
  ]);
}

export async function ensureApiHostPermission(baseUrl: string): Promise<boolean> {
  const originPattern = toOriginPattern(baseUrl);
  if (!originPattern) {
    return false;
  }

  try {
    const alreadyGranted = await browser.permissions.contains({
      origins: [originPattern],
    });
    if (alreadyGranted) {
      return true;
    }

    return browser.permissions.request({
      origins: [originPattern],
    });
  } catch {
    return false;
  }
}

export async function hasApiToken(): Promise<boolean> {
  const stored = await browser.storage.local.get(LOCAL_KEYS);
  return typeof stored.apiAuthToken === 'string' && stored.apiAuthToken.length > 0;
}

export { DEFAULT_API_BASE_URL };
