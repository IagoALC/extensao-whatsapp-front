import browser from 'webextension-polyfill';

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    const sync = await browser.storage.sync.get(['consentGranted']);
    if (typeof sync.consentGranted !== 'boolean') {
      await browser.storage.sync.set({ consentGranted: false });
    }
  });
});
