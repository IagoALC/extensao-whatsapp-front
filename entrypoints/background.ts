import browser from 'webextension-polyfill';
import { DEFAULT_API_BASE_URL } from '../src/core/settings';

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    const [sync, local] = await Promise.all([
      browser.storage.sync.get(['apiBaseUrl', 'consentGranted']),
      browser.storage.local.get(['apiAuthToken']),
    ]);

    if (!sync.apiBaseUrl) {
      await browser.storage.sync.set({ apiBaseUrl: DEFAULT_API_BASE_URL });
    }
    if (typeof sync.consentGranted !== 'boolean') {
      await browser.storage.sync.set({ consentGranted: false });
    }
    if (typeof local.apiAuthToken !== 'string') {
      await browser.storage.local.set({ apiAuthToken: '' });
    }
  });
});
