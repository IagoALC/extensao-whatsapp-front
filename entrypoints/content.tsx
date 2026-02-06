import { createRoot } from 'react-dom/client';
import browser from 'webextension-polyfill';
import { WhatsappConversationObserver } from '../src/content/whatsapp-observer';
import { createApiClient } from '../src/core/api-client';
import { LocalJobQueue } from '../src/core/job-queue';
import {
  getRuntimeSettings,
  setConsentGranted,
} from '../src/core/settings';
import {
  db,
  pruneOldData,
  saveMessage,
  upsertConversation,
  type WACopilotDb,
} from '../src/storage/db';
import {
  getCurrentConversationId,
  getCurrentConversationTitle,
} from '../src/shared/message-normalizer';
import SidebarApp from '../src/ui/sidebar/App';

const HOST_ID = 'wa-copilot-sidebar-host';
const POLL_INTERVAL_MS = 2000;

type AppRuntime = {
  db: WACopilotDb;
  queue: LocalJobQueue;
};

interface RenderOptions {
  consentGranted: boolean;
  onGrantConsent: () => Promise<void>;
  onRevokeConsent: () => Promise<void>;
}

function ensureSidebarMount(): HTMLElement {
  const existingHost = document.getElementById(HOST_ID);
  if (existingHost?.shadowRoot) {
    const existingMount = existingHost.shadowRoot.getElementById('wa-copilot-mount');
    if (existingMount) {
      return existingMount;
    }
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.position = 'fixed';
  host.style.top = '16px';
  host.style.right = '16px';
  host.style.zIndex = '2147483647';

  const shadowRoot = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
    }

    #wa-copilot-mount {
      width: 328px;
      max-height: calc(100vh - 32px);
      overflow: auto;
      font-family: "Segoe UI", Tahoma, sans-serif;
      color: #122620;
    }
  `;
  shadowRoot.append(style);

  const mount = document.createElement('div');
  mount.id = 'wa-copilot-mount';
  shadowRoot.append(mount);

  document.body.append(host);
  return mount;
}

function notifyNewMessage(conversationId: string, eventId: string): void {
  window.dispatchEvent(
    new CustomEvent('wa-copilot:new-message', {
      detail: { conversationId, eventId },
    }),
  );
}

function renderApp(
  root: ReturnType<typeof createRoot>,
  runtime: AppRuntime,
  conversationId: string,
  conversationTitle: string,
  options: RenderOptions,
): void {
  root.render(
    <SidebarApp
      conversationId={conversationId}
      conversationTitle={conversationTitle}
      db={runtime.db}
      queue={runtime.queue}
      consentGranted={options.consentGranted}
      onGrantConsent={options.onGrantConsent}
      onRevokeConsent={options.onRevokeConsent}
    />,
  );
}

export default defineContentScript({
  matches: ['https://web.whatsapp.com/*'],
  runAt: 'document_idle',
  main() {
    if (window.top !== window.self) {
      return;
    }

    void pruneOldData().catch(() => {
      // Avoid breaking the extension if local cleanup fails.
    });

    const mount = ensureSidebarMount();
    const root = createRoot(mount);

    void (async () => {
      const apiClient = await createApiClient();
      const queue = new LocalJobQueue({ db, apiClient });
      queue.start();

      const runtime: AppRuntime = { db, queue };
      let currentConversationId = getCurrentConversationId();
      let currentConversationTitle = getCurrentConversationTitle();
      const settings = await getRuntimeSettings();
      let consentGranted = settings.consentGranted;
      let observer: WhatsappConversationObserver | null = null;

      const stopObserver = () => {
        observer?.stop();
        observer = null;
      };

      const startObserver = () => {
        if (observer || !consentGranted) {
          return;
        }

        observer = new WhatsappConversationObserver({
          tenantId: 'default',
          getConversationId: () => getCurrentConversationId(),
          onMessage: async (event) => {
            const inserted = await saveMessage(event);
            if (!inserted) {
              return;
            }
            await upsertConversation(
              event.conversationId,
              getCurrentConversationTitle(),
            );
            notifyNewMessage(event.conversationId, event.eventId);
          },
        });
        observer.start();
      };

      const rerender = () =>
        renderApp(root, runtime, currentConversationId, currentConversationTitle, {
          consentGranted,
          onGrantConsent: async () => {
            await setConsentGranted(true);
            consentGranted = true;
            startObserver();
            rerender();
          },
          onRevokeConsent: async () => {
            await setConsentGranted(false);
            consentGranted = false;
            stopObserver();
            rerender();
          },
        });

      rerender();
      if (consentGranted) {
        startObserver();
      }

      browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync' || !changes.consentGranted) {
          return;
        }

        consentGranted = changes.consentGranted.newValue === true;
        if (consentGranted) {
          startObserver();
        } else {
          stopObserver();
        }
        rerender();
      });

      window.setInterval(() => {
        const nextConversationId = getCurrentConversationId();
        const nextConversationTitle = getCurrentConversationTitle();
        if (
          nextConversationId !== currentConversationId ||
          nextConversationTitle !== currentConversationTitle
        ) {
          currentConversationId = nextConversationId;
          currentConversationTitle = nextConversationTitle;
          rerender();
        }
      }, POLL_INTERVAL_MS);
    })();
  },
});
