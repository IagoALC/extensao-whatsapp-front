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
  hasOpenConversation,
} from '../src/shared/message-normalizer';
import SidebarApp from '../src/ui/sidebar/App';

const HOST_ID = 'wa-copilot-sidebar-host';
const POLL_INTERVAL_MS = 2000;
const CLOSE_STABILITY_POLLS = 3;
const OBSERVER_RESCAN_EVERY_POLLS = 4;
const OBSERVER_INITIAL_RESCAN_DELAYS_MS = [0, 250, 900, 1800, 3200, 5000];
const BOOT_LOCK_ATTR = 'data-wa-copilot-boot-owner';
const UNKNOWN_CONVERSATION_ID = 'wa:unknown';
const UNKNOWN_CONVERSATION_TITLE = 'Conversa atual';

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
  if (existingHost) {
    const owner = existingHost.getAttribute(BOOT_LOCK_ATTR);
    if (owner && owner !== browser.runtime.id) {
      throw new Error(
        `wa-copilot host already owned by another extension (${owner})`,
      );
    }
  }
  if (existingHost?.shadowRoot) {
    const existingMount = existingHost.shadowRoot.getElementById('wa-copilot-mount');
    if (existingMount) {
      return existingMount;
    }
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute(BOOT_LOCK_ATTR, browser.runtime.id);
  host.style.position = 'fixed';
  host.style.top = '12px';
  host.style.right = '12px';
  host.style.zIndex = '2147483647';

  const shadowRoot = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      color-scheme: light;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    #wa-copilot-mount {
      --wa-color-bg-1: #f5fbf8;
      --wa-color-bg-2: #edf7ff;
      --wa-color-surface: #ffffff;
      --wa-color-surface-soft: #f7fbff;
      --wa-color-border: #d8e6f2;
      --wa-color-border-strong: #b9d0e1;
      --wa-color-text: #102a3c;
      --wa-color-text-muted: #4f6779;
      --wa-color-primary: #0b8a6a;
      --wa-color-primary-strong: #087255;
      --wa-color-secondary: #1f6b8a;
      --wa-color-danger: #c4424e;
      --wa-color-warning: #c07c16;
      --wa-color-success: #14896b;
      --wa-shadow-soft: 0 8px 20px rgba(16, 42, 60, 0.12);
      --wa-shadow-strong: 0 16px 32px rgba(16, 42, 60, 0.16);
      --wa-shadow-focus: 0 0 0 3px rgba(11, 138, 106, 0.22);
      width: min(420px, calc(100vw - 24px));
      max-height: calc(100vh - 24px);
      overflow: visible;
      border-radius: 20px;
      padding: 4px;
      background:
        radial-gradient(circle at 0% 0%, rgba(11, 138, 106, 0.16), transparent 45%),
        radial-gradient(circle at 100% 0%, rgba(31, 107, 138, 0.18), transparent 38%),
        linear-gradient(160deg, var(--wa-color-bg-1) 0%, var(--wa-color-bg-2) 100%);
      font-family: "Manrope", "Plus Jakarta Sans", "Avenir Next", "Segoe UI", sans-serif;
      color: var(--wa-color-text);
    }

    .wa-layout {
      position: relative;
    }

    .wa-shell {
      display: grid;
      gap: 12px;
      padding: 6px;
      max-height: calc(100vh - 24px);
      overflow: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(16, 42, 60, 0.35) transparent;
      animation: wa-shell-enter 220ms ease-out;
    }

    .wa-shell::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    .wa-shell::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: rgba(16, 42, 60, 0.32);
    }

    .wa-shell::-webkit-scrollbar-track {
      background: transparent;
    }

    @keyframes wa-shell-enter {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .wa-card {
      display: grid;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--wa-color-border);
      border-radius: 16px;
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.94) 0%,
        rgba(255, 255, 255, 0.84) 100%
      );
      box-shadow: var(--wa-shadow-soft);
      backdrop-filter: blur(6px);
    }

    .wa-card--elevated {
      background:
        radial-gradient(circle at 90% -10%, rgba(11, 138, 106, 0.14), transparent 48%),
        linear-gradient(180deg, #ffffff 0%, #f8fcff 100%);
      box-shadow: var(--wa-shadow-strong);
    }

    .wa-card--soft {
      background:
        radial-gradient(circle at -10% -20%, rgba(31, 107, 138, 0.14), transparent 46%),
        linear-gradient(180deg, #ffffff 0%, var(--wa-color-surface-soft) 100%);
    }

    .wa-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .wa-eyebrow {
      margin: 0;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--wa-color-primary-strong);
    }

    .wa-brand-title {
      margin: 2px 0 0;
      font-size: 22px;
      line-height: 1.15;
      letter-spacing: -0.02em;
      color: var(--wa-color-text);
    }

    .wa-subtitle {
      margin: 4px 0 0;
      font-size: 12px;
      line-height: 1.45;
      color: var(--wa-color-text-muted);
      max-width: 220px;
    }

    .wa-header-badges {
      display: grid;
      gap: 6px;
      justify-items: end;
      margin-top: 2px;
    }

    .wa-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid rgba(31, 107, 138, 0.22);
      background: rgba(31, 107, 138, 0.08);
      color: var(--wa-color-secondary);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .wa-pill--ok {
      border-color: rgba(20, 137, 107, 0.26);
      background: rgba(20, 137, 107, 0.13);
      color: #0a6a53;
    }

    .wa-pill--warning {
      border-color: rgba(192, 124, 22, 0.34);
      background: rgba(192, 124, 22, 0.14);
      color: #8a5a15;
    }

    .wa-card-head {
      display: grid;
      gap: 4px;
    }

    .wa-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--wa-color-text-muted);
    }

    .wa-conversation-title {
      margin: 0;
      font-size: 17px;
      line-height: 1.35;
      letter-spacing: -0.01em;
      color: var(--wa-color-text);
      word-break: break-word;
    }

    .wa-section-title {
      margin: 0;
      font-size: 14px;
      letter-spacing: -0.01em;
      color: var(--wa-color-text);
    }

    .wa-section-copy {
      margin: 0;
      font-size: 12px;
      line-height: 1.45;
      color: var(--wa-color-text-muted);
    }

    .wa-metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }

    .wa-metric-card {
      display: grid;
      gap: 4px;
      min-height: 70px;
      padding: 9px 10px;
      border-radius: 12px;
      border: 1px solid var(--wa-color-border);
      background: rgba(255, 255, 255, 0.88);
    }

    .wa-metric-label {
      font-size: 11px;
      line-height: 1.2;
      color: var(--wa-color-text-muted);
    }

    .wa-metric-value {
      font-size: 20px;
      line-height: 1.1;
      letter-spacing: -0.02em;
      color: var(--wa-color-text);
    }

    .wa-field-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .wa-field {
      display: grid;
      gap: 6px;
    }

    .wa-field-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--wa-color-text-muted);
    }

    .wa-input,
    .wa-select {
      width: 100%;
      min-height: 36px;
      border-radius: 10px;
      border: 1px solid var(--wa-color-border-strong);
      background: rgba(255, 255, 255, 0.92);
      color: var(--wa-color-text);
      font-size: 13px;
      font-weight: 500;
      padding: 0 10px;
      transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
    }

    .wa-input:focus-visible,
    .wa-select:focus-visible,
    .wa-range:focus-visible {
      outline: none;
      border-color: var(--wa-color-primary);
      box-shadow: var(--wa-shadow-focus);
      background: #ffffff;
    }

    .wa-input--compact {
      max-width: 110px;
    }

    .wa-range-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .wa-range-value {
      font-size: 12px;
      font-weight: 700;
      color: var(--wa-color-secondary);
    }

    .wa-range {
      width: 100%;
      accent-color: var(--wa-color-primary);
      cursor: pointer;
    }

    .wa-action-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .wa-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 36px;
      border-radius: 12px;
      border: 1px solid transparent;
      background: #ffffff;
      padding: 0 12px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: var(--wa-color-text);
      cursor: pointer;
      transition:
        transform 150ms ease,
        box-shadow 150ms ease,
        border-color 150ms ease,
        background-color 150ms ease,
        color 150ms ease;
    }

    .wa-btn:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: var(--wa-shadow-soft);
    }

    .wa-btn:active:not(:disabled) {
      transform: translateY(0);
      box-shadow: none;
    }

    .wa-btn:focus-visible {
      outline: none;
      box-shadow: var(--wa-shadow-focus);
    }

    .wa-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .wa-btn--lg {
      min-height: 40px;
      font-size: 13px;
    }

    .wa-btn--tiny {
      min-height: 30px;
      font-size: 11px;
      font-weight: 700;
      border-radius: 10px;
      padding: 0 10px;
    }

    .wa-btn--fit {
      width: auto;
    }

    .wa-action-grid .wa-btn--lg {
      grid-column: 1 / -1;
    }

    .wa-action-grid > .wa-btn:last-child {
      grid-column: 1 / -1;
    }

    .wa-btn--primary {
      background: linear-gradient(160deg, var(--wa-color-primary) 0%, var(--wa-color-primary-strong) 100%);
      color: #ffffff;
      border-color: rgba(8, 114, 85, 0.35);
    }

    .wa-btn--secondary {
      background: linear-gradient(170deg, #edf7fc 0%, #e1f0fb 100%);
      color: #155f7f;
      border-color: rgba(31, 107, 138, 0.24);
    }

    .wa-btn--subtle {
      background: linear-gradient(170deg, #f0f8f4 0%, #e8f4ee 100%);
      color: #0f6f56;
      border-color: rgba(11, 138, 106, 0.2);
    }

    .wa-btn--warning {
      background: linear-gradient(170deg, #fff8e9 0%, #fff2d2 100%);
      color: #8a5a15;
      border-color: rgba(192, 124, 22, 0.32);
    }

    .wa-btn--danger {
      background: linear-gradient(170deg, #fff0f2 0%, #ffe7eb 100%);
      color: #9d2434;
      border-color: rgba(196, 66, 78, 0.3);
    }

    .wa-btn--ghost {
      background: rgba(255, 255, 255, 0.86);
      color: #2f4f64;
      border-color: rgba(47, 79, 100, 0.2);
    }

    .wa-empty-state {
      display: grid;
      gap: 4px;
      padding: 12px;
      border-radius: 12px;
      border: 1px dashed rgba(47, 79, 100, 0.24);
      background: rgba(255, 255, 255, 0.72);
      font-size: 12px;
      color: var(--wa-color-text-muted);
    }

    .wa-empty-state strong {
      font-size: 13px;
      color: var(--wa-color-text);
    }

    .wa-suggestions-popout {
      position: absolute;
      right: calc(100% + 14px);
      top: 6px;
      width: min(392px, calc(100vw - 460px));
      max-height: calc(100vh - 32px);
      z-index: 6;
      opacity: 0;
      transform: translateX(14px) scale(0.985);
      transform-origin: right top;
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
    }

    .wa-suggestions-popout--open {
      opacity: 1;
      transform: translateX(0) scale(1);
      pointer-events: auto;
    }

    .wa-suggestions-popout > .wa-card {
      max-height: calc(100vh - 32px);
      overflow: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(16, 42, 60, 0.35) transparent;
    }

    .wa-suggestions-popout > .wa-card::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    .wa-suggestions-popout > .wa-card::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: rgba(16, 42, 60, 0.32);
    }

    .wa-suggestions-popout-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .wa-suggestions-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 10px;
    }

    .wa-suggestion-item {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-radius: 13px;
      border: 1px solid var(--wa-color-border);
      background: rgba(255, 255, 255, 0.9);
    }

    .wa-suggestion-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .wa-rank {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      background: rgba(11, 138, 106, 0.12);
      color: var(--wa-color-primary-strong);
      font-size: 11px;
      font-weight: 700;
    }

    .wa-suggestion-meta {
      font-size: 11px;
      color: var(--wa-color-text-muted);
    }

    .wa-suggestion-content {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--wa-color-text);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .wa-suggestion-rationale {
      margin: 0;
      font-size: 12px;
      color: #2d617b;
      line-height: 1.45;
    }

    .wa-guard {
      display: grid;
      gap: 6px;
    }

    .wa-guard-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }

    .wa-guard-note {
      font-size: 11px;
      color: var(--wa-color-text-muted);
    }

    .wa-guard-feedback {
      font-size: 11px;
      line-height: 1.35;
      font-weight: 600;
    }

    .wa-guard-feedback--ok {
      color: #0a6a53;
    }

    .wa-guard-feedback--error {
      color: #9d2434;
    }

    .wa-status-banner {
      display: grid;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid transparent;
      font-size: 12px;
      line-height: 1.45;
      animation: wa-status-enter 180ms ease-out;
    }

    @keyframes wa-status-enter {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .wa-status-banner--success {
      border-color: rgba(20, 137, 107, 0.24);
      background: rgba(20, 137, 107, 0.12);
      color: #0a6a53;
    }

    .wa-status-banner--error {
      border-color: rgba(196, 66, 78, 0.3);
      background: rgba(196, 66, 78, 0.12);
      color: #8c1e2d;
    }

    @media (max-width: 1320px) {
      .wa-suggestions-popout {
        right: 0;
        top: calc(100% + 10px);
        width: 100%;
        max-height: 42vh;
        transform-origin: top right;
        transform: translateY(-8px) scale(0.985);
      }

      .wa-suggestions-popout--open {
        transform: translateY(0) scale(1);
      }

      .wa-suggestions-popout > .wa-card {
        max-height: 42vh;
      }
    }

    @media (max-width: 920px) {
      #wa-copilot-mount {
        width: min(408px, calc(100vw - 16px));
        max-height: calc(100vh - 16px);
      }
    }

    @media (max-width: 700px) {
      #wa-copilot-mount {
        width: calc(100vw - 12px);
        max-height: calc(100vh - 12px);
      }

      .wa-header {
        flex-direction: column;
      }

      .wa-header-badges {
        justify-items: start;
      }

      .wa-metric-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .wa-field-grid,
      .wa-action-grid {
        grid-template-columns: 1fr;
      }

      .wa-action-grid .wa-btn--lg,
      .wa-action-grid > .wa-btn:last-child {
        grid-column: auto;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .wa-shell,
      .wa-status-banner {
        animation: none;
      }

      .wa-btn {
        transition: none;
      }
    }
  `;
  shadowRoot.append(style);

  const mount = document.createElement('div');
  mount.id = 'wa-copilot-mount';
  shadowRoot.append(mount);

  document.body.append(host);
  return mount;
}

function acquireBootLock(): boolean {
  const root = document.documentElement;
  const activeOwner = root.getAttribute(BOOT_LOCK_ATTR);
  if (activeOwner) {
    return false;
  }
  root.setAttribute(BOOT_LOCK_ATTR, browser.runtime.id);
  return true;
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
  conversationOpen: boolean,
  options: RenderOptions,
): void {
  root.render(
    <SidebarApp
      conversationId={conversationId}
      conversationTitle={conversationTitle}
      conversationOpen={conversationOpen}
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
    if (!acquireBootLock()) {
      return;
    }

    void pruneOldData().catch(() => {
      // Avoid breaking the extension if local cleanup fails.
    });

    const mount = ensureSidebarMount();
    if (mount.childNodes.length > 0 || mount.getAttribute('data-wa-copilot-mounted') === '1') {
      return;
    }
    mount.setAttribute('data-wa-copilot-mounted', '1');
    const root = createRoot(mount);

    void (async () => {
      const apiClient = await createApiClient();
      const queue = new LocalJobQueue({ db, apiClient });
      queue.start();

      const runtime: AppRuntime = { db, queue };
      let currentConversationId = getCurrentConversationId();
      let currentConversationTitle = getCurrentConversationTitle();
      let currentConversationOpen = hasOpenConversation();
      let closedPollStreak = 0;
      let pollCount = 0;
      const settings = await getRuntimeSettings();
      let consentGranted = settings.consentGranted;
      let observer: WhatsappConversationObserver | null = null;
      let observerInitialRescanTimers: number[] = [];
      const hasKnownConversationId = () =>
        currentConversationId !== UNKNOWN_CONVERSATION_ID;

      const clearInitialObserverRescans = () => {
        for (const timerId of observerInitialRescanTimers) {
          window.clearTimeout(timerId);
        }
        observerInitialRescanTimers = [];
      };

      const scheduleInitialObserverRescans = () => {
        clearInitialObserverRescans();
        if (!observer || !consentGranted || !hasKnownConversationId()) {
          return;
        }
        observerInitialRescanTimers = OBSERVER_INITIAL_RESCAN_DELAYS_MS.map(
          (delayMs) =>
            window.setTimeout(() => {
              if (!observer || !consentGranted || !hasKnownConversationId()) {
                return;
              }
              observer.refreshSnapshot();
            }, delayMs),
        );
      };

      const stopObserver = () => {
        clearInitialObserverRescans();
        observer?.stop();
        observer = null;
      };

      const startObserver = () => {
        if (observer || !consentGranted) {
          return;
        }

        observer = new WhatsappConversationObserver({
          tenantId: 'default',
          getConversationId: () => (hasKnownConversationId() ? currentConversationId : ''),
          onMessage: async (event) => {
            const inserted = await saveMessage(event);
            if (!inserted) {
              return;
            }
            await upsertConversation(event.conversationId, currentConversationTitle);
            notifyNewMessage(event.conversationId, event.eventId);
          },
        });
        observer.start();
        scheduleInitialObserverRescans();
      };

      const rerender = () =>
        renderApp(
          root,
          runtime,
          currentConversationId,
          currentConversationTitle,
          currentConversationOpen,
          {
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
          },
        );

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
        pollCount += 1;
        const rawConversationId = getCurrentConversationId();
        const rawConversationTitle = getCurrentConversationTitle();
        const detectedConversationOpen =
          hasOpenConversation() || rawConversationId !== UNKNOWN_CONVERSATION_ID;
        if (detectedConversationOpen) {
          closedPollStreak = 0;
        } else {
          closedPollStreak += 1;
        }

        const nextConversationOpen =
          detectedConversationOpen || closedPollStreak < CLOSE_STABILITY_POLLS;

        const isRawConversationIdUnknown =
          rawConversationId === UNKNOWN_CONVERSATION_ID;
        const isRawConversationTitleUnknown =
          rawConversationTitle === UNKNOWN_CONVERSATION_TITLE;
        const shouldPreserveCurrentConversationIdentity =
          (currentConversationOpen || nextConversationOpen) &&
          (isRawConversationIdUnknown || isRawConversationTitleUnknown);
        const shouldKeepKnownConversationId =
          currentConversationId !== UNKNOWN_CONVERSATION_ID &&
          isRawConversationIdUnknown;
        const shouldKeepKnownConversationTitle =
          currentConversationTitle !== UNKNOWN_CONVERSATION_TITLE &&
          isRawConversationTitleUnknown;
        const isLikelySameConversationWithDifferentIdSource =
          currentConversationOpen &&
          nextConversationOpen &&
          currentConversationId !== UNKNOWN_CONVERSATION_ID &&
          rawConversationId !== currentConversationId &&
          (isRawConversationTitleUnknown ||
            currentConversationTitle === UNKNOWN_CONVERSATION_TITLE ||
            rawConversationTitle === currentConversationTitle);

        const nextConversationId =
          shouldKeepKnownConversationId ||
          isLikelySameConversationWithDifferentIdSource ||
          (shouldPreserveCurrentConversationIdentity && isRawConversationIdUnknown)
            ? currentConversationId
            : rawConversationId;
        const nextConversationTitle =
          shouldKeepKnownConversationTitle ||
          (shouldPreserveCurrentConversationIdentity && isRawConversationTitleUnknown)
            ? currentConversationTitle
            : rawConversationTitle;
        const conversationChanged =
          nextConversationId !== currentConversationId ||
          nextConversationTitle !== currentConversationTitle ||
          nextConversationOpen !== currentConversationOpen;

        if (conversationChanged) {
          currentConversationId = nextConversationId;
          currentConversationTitle = nextConversationTitle;
          currentConversationOpen = nextConversationOpen;
          rerender();
          if (observer && consentGranted && hasKnownConversationId()) {
            scheduleInitialObserverRescans();
          }
        }

        if (
          observer &&
          consentGranted &&
          hasKnownConversationId() &&
          pollCount % OBSERVER_RESCAN_EVERY_POLLS === 0
        ) {
          observer.refreshSnapshot();
        }
      }, POLL_INTERVAL_MS);
    })();
  },
});
