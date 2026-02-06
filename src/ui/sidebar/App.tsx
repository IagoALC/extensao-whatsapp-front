import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ReportRequest,
  type SummaryRequest,
  type Tone,
  ApiError,
  createApiClient,
  type SuggestionResponse,
} from '../../core/api-client';
import type { QueueEvent, LocalJobQueue } from '../../core/job-queue';
import {
  clearConversationData,
  countMessagesByConversation,
  listMessagesByConversation,
  type MessageRecord,
  type WACopilotDb,
} from '../../storage/db';
import SendGuard from './SendGuard';

interface SidebarAppProps {
  conversationId: string;
  conversationTitle: string;
  conversationOpen: boolean;
  db: WACopilotDb;
  queue: LocalJobQueue;
  consentGranted: boolean;
  onGrantConsent: () => Promise<void>;
  onRevokeConsent: () => Promise<void>;
}

const MIN_CONTEXT_MESSAGES = 12;
const MAX_CONTEXT_MESSAGES = 80;
const MAX_CONTEXT_MESSAGE_CHARS = 360;
const MIN_CONTEXT_WINDOW = 5;
const MAX_CONTEXT_WINDOW = 80;
const INITIAL_CONTEXT_CAPTURE_LIMIT = MAX_CONTEXT_MESSAGES;
const INITIAL_CONTEXT_CAPTURE_DELAYS_MS = [250, 900, 1800, 3200, 5000];

function deriveSuggestionMessageLimit(contextWindow: number): number {
  if (!Number.isFinite(contextWindow)) {
    return 20;
  }
  const scaled = Math.round(contextWindow * 2);
  if (scaled < MIN_CONTEXT_MESSAGES) {
    return MIN_CONTEXT_MESSAGES;
  }
  if (scaled > MAX_CONTEXT_MESSAGES) {
    return MAX_CONTEXT_MESSAGES;
  }
  return scaled;
}

function truncateContextMessage(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function formatMessageForSuggestionContext(message: MessageRecord): string {
  const speaker =
    message.authorRole === 'self'
      ? 'Voce'
      : message.authorRole === 'contact'
        ? 'Contato'
        : 'Sistema';
  const normalized = (message.textNormalized || message.text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return '';
  }
  return `${speaker}: ${truncateContextMessage(normalized, MAX_CONTEXT_MESSAGE_CHARS)}`;
}

function buildSuggestionContext(messages: MessageRecord[]): string[] {
  // DB returns newest-first; reverse to preserve natural conversation flow.
  return [...messages]
    .reverse()
    .map((message) => formatMessageForSuggestionContext(message))
    .filter((message) => message.length > 0);
}

function formatConversationLabel(conversationId: string): string {
  const normalized = conversationId
    .replace(/^wa:title:/i, '')
    .replace(/^wa:path:/i, '')
    .replace(/^wa:/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  if (normalized.length > 0) {
    return normalized;
  }
  return 'Conversa atual';
}

function formatQueueEvent(event: QueueEvent): string {
  if (event.type === 'enqueued') {
    return `Job ${event.kind} enfileirado (${event.jobId.slice(0, 8)}).`;
  }
  if (event.type === 'completed') {
    return `Job ${event.kind} aceito no backend (id ${event.remoteJobId ?? '-' }).`;
  }
  if (event.type === 'retry_scheduled') {
    return `Falha temporaria em ${event.kind}. Novo retry agendado.`;
  }
  return `Falha permanente em ${event.kind}: ${event.error ?? 'erro desconhecido'}.`;
}

function mapApiError(error: unknown): string {
  if (error instanceof ApiError) {
    const payloadMessage =
      typeof error.body === 'object' &&
      error.body !== null &&
      'error' in error.body &&
      typeof (error.body as { error?: { message?: unknown } }).error?.message ===
        'string'
        ? ((error.body as { error?: { message?: string } }).error?.message ?? '')
        : '';

    if (error.status === 401 || error.status === 403) {
      return 'Falha de autenticacao. Confira o token definido em codigo.';
    }
    if (error.status === 400 && payloadMessage) {
      return `Requisicao invalida: ${payloadMessage}`;
    }
    if (error.status === 429) {
      return 'Limite de requisicoes atingido. Tente novamente em instantes.';
    }
    if (error.status === 504) {
      return 'Tempo limite excedido ao chamar o backend.';
    }
    if (payloadMessage) {
      return `Erro de API (${error.status}): ${payloadMessage}`;
    }
    return `Erro de API (${error.status}).`;
  }

  if (error instanceof Error) {
    return error.message;
  }
  return 'Erro desconhecido.';
}

function clampContextWindow(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }
  if (value < MIN_CONTEXT_WINDOW) {
    return MIN_CONTEXT_WINDOW;
  }
  if (value > MAX_CONTEXT_WINDOW) {
    return MAX_CONTEXT_WINDOW;
  }
  return Math.round(value);
}

async function copyTextToClipboard(text: string): Promise<void> {
  const value = text.trim();
  if (!value) {
    throw new Error('Sugestao vazia.');
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const helper = document.createElement('textarea');
  helper.value = value;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  helper.style.pointerEvents = 'none';
  document.body.append(helper);
  helper.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(helper);
  if (!copied) {
    throw new Error('Nao foi possivel copiar para a area de transferencia.');
  }
}

function isVisibleElement(element: Element): element is HTMLElement {
  const target = element as HTMLElement;
  return !!target.offsetParent || target.getClientRects().length > 0;
}

function findWhatsappComposer(): HTMLElement | null {
  const selectors = [
    'footer div[contenteditable="true"][data-tab]',
    'footer [role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ];

  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    const target = nodes.find(isVisibleElement);
    if (target) {
      return target;
    }
  }
  return null;
}

function insertTextIntoComposer(text: string): void {
  const composer = findWhatsappComposer();
  if (!composer) {
    throw new Error('Campo de mensagem do WhatsApp nao encontrado.');
  }

  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);

  const inserted = document.execCommand('insertText', false, text);
  if (!inserted) {
    const current = composer.textContent ?? '';
    const separator = current.trim().length > 0 ? ' ' : '';
    composer.textContent = `${current}${separator}${text}`;
  }

  composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

function SidebarApp({
  conversationId,
  conversationTitle,
  conversationOpen,
  db,
  queue,
  consentGranted,
  onGrantConsent,
  onRevokeConsent,
}: SidebarAppProps) {
  const [tone, setTone] = useState<Tone>('neutro');
  const [locale, setLocale] = useState('pt-BR');
  const [contextWindow, setContextWindow] = useState(20);
  const [messageCount, setMessageCount] = useState(0);
  const [suggestions, setSuggestions] = useState<SuggestionResponse['suggestions']>(
    [],
  );
  const [suggestionsQuality, setSuggestionsQuality] = useState<number | null>(null);
  const [hitlRequired, setHitlRequired] = useState(true);
  const [queuePending, setQueuePending] = useState(0);
  const [queueFailed, setQueueFailed] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [updatingConsent, setUpdatingConsent] = useState(false);
  const [initialContextMessages, setInitialContextMessages] = useState<string[]>(
    [],
  );
  const [initialContextCaptured, setInitialContextCaptured] = useState(false);
  const initialContextCapturedRef = useRef(false);

  const conversationRef = useMemo(
    () => ({
      tenant_id: 'default',
      conversation_id: conversationId,
      channel: 'whatsapp_web' as const,
    }),
    [conversationId],
  );

  useEffect(() => {
    let mounted = true;

    const refreshMetrics = async () => {
      const [count, queueStats] = await Promise.all([
        countMessagesByConversation(conversationId),
        queue.getStats(),
      ]);
      if (!mounted) {
        return;
      }
      setMessageCount(count);
      setQueuePending(queueStats.pending);
      setQueueFailed(queueStats.failed);
    };

    const onQueueEvent = (event: QueueEvent) => {
      setStatusText(formatQueueEvent(event));
      if (event.type === 'failed') {
        setErrorText(formatQueueEvent(event));
      }
      void refreshMetrics();
    };

    const unsubscribe = queue.subscribe(onQueueEvent);
    const onNewMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId: string }>).detail;
      if (detail?.conversationId === conversationId) {
        void refreshMetrics();
      }
    };

    window.addEventListener(
      'wa-copilot:new-message',
      onNewMessage as EventListener,
    );

    void refreshMetrics();
    const intervalId = window.setInterval(() => {
      void refreshMetrics();
    }, 4000);

    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener(
        'wa-copilot:new-message',
        onNewMessage as EventListener,
      );
      window.clearInterval(intervalId);
    };
  }, [conversationId, db, queue]);

  useEffect(() => {
    let mounted = true;
    initialContextCapturedRef.current = false;
    setInitialContextCaptured(false);
    setInitialContextMessages([]);

    if (!conversationOpen) {
      return () => {
        mounted = false;
      };
    }

    const tryCaptureInitialContext = async () => {
      if (!mounted || initialContextCapturedRef.current) {
        return;
      }

      const recentMessages = await listMessagesByConversation(
        conversationId,
        INITIAL_CONTEXT_CAPTURE_LIMIT,
      );
      const contextMessages = buildSuggestionContext(recentMessages);
      if (contextMessages.length === 0) {
        return;
      }

      if (!mounted || initialContextCapturedRef.current) {
        return;
      }

      initialContextCapturedRef.current = true;
      setInitialContextMessages(contextMessages);
      setInitialContextCaptured(true);
      setStatusText(
        `Contexto inicial capturado (${contextMessages.length} mensagem(ns)).`,
      );
    };

    void tryCaptureInitialContext();
    const timers = INITIAL_CONTEXT_CAPTURE_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        void tryCaptureInitialContext();
      }, delayMs),
    );

    return () => {
      mounted = false;
      for (const timerId of timers) {
        window.clearTimeout(timerId);
      }
    };
  }, [conversationId, conversationOpen]);

  useEffect(() => {
    setSuggestions([]);
    setSuggestionsQuality(null);
    setHitlRequired(true);
    setErrorText('');
    if (!initialContextCapturedRef.current) {
      setStatusText('');
    }
  }, [conversationId, conversationOpen]);

  const handleGenerateSuggestions = async () => {
    if (!conversationOpen) {
      setErrorText('Abra uma conversa no WhatsApp para gerar sugestoes.');
      return;
    }
    const hasStoredContext =
      initialContextMessages.length > 0 || messageCount > 0;
    if (!consentGranted && !hasStoredContext) {
      setErrorText(
        'Conceda consentimento para capturar contexto antes de gerar sugestoes.',
      );
      return;
    }

    setLoadingSuggestions(true);
    setErrorText('');
    setStatusText('');

    try {
      const contextLimit = deriveSuggestionMessageLimit(contextWindow);
      let contextMessages =
        initialContextCaptured && initialContextMessages.length > 0
          ? initialContextMessages.slice(-contextLimit)
          : [];

      if (contextMessages.length === 0) {
        const recentMessages = await listMessagesByConversation(
          conversationId,
          contextLimit,
        );
        contextMessages = buildSuggestionContext(recentMessages);
      }

      if (contextMessages.length === 0) {
        setErrorText(
          'Nenhuma mensagem capturada para contexto. Aguarde alguns segundos e tente novamente.',
        );
        return;
      }

      const apiClient = await createApiClient();
      const response = await apiClient.createSuggestions({
        conversation: conversationRef,
        locale,
        tone,
        context_window: contextWindow,
        messages: contextMessages,
      });
      setSuggestions(response.suggestions);
      setSuggestionsQuality(
        typeof response.quality_score === 'number' ? response.quality_score : null,
      );
      setHitlRequired(response.hitl_required !== false);
      setStatusText(
        initialContextCaptured && initialContextMessages.length > 0
          ? 'Sugestoes geradas com base no contexto inicial carregado.'
          : !consentGranted
            ? 'Sugestoes geradas com contexto local ja capturado.'
          : 'Sugestoes geradas com sucesso.',
      );
    } catch (error) {
      setSuggestionsQuality(null);
      setErrorText(`Erro ao gerar sugestoes: ${mapApiError(error)}`);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleCopySuggestion = async (content: string): Promise<void> => {
    setErrorText('');
    try {
      await copyTextToClipboard(content);
      setStatusText('Sugestao copiada. Revise antes de enviar manualmente.');
    } catch (error) {
      const message = `Falha ao copiar sugestao: ${mapApiError(error)}`;
      setErrorText(message);
      throw new Error(message);
    }
  };

  const handleInsertSuggestion = async (content: string): Promise<void> => {
    setErrorText('');
    try {
      insertTextIntoComposer(content);
      setStatusText('Sugestao inserida no campo. Revisao e envio seguem manuais.');
    } catch (error) {
      const message = `Falha ao inserir sugestao: ${mapApiError(error)}`;
      setErrorText(message);
      throw new Error(message);
    }
  };

  const handleEnqueueSummary = async () => {
    if (!consentGranted) {
      setErrorText('Consentimento obrigatorio para gerar resumo.');
      return;
    }

    setErrorText('');
    setStatusText('');
    try {
      const payload: SummaryRequest = {
        conversation: conversationRef,
        summary_type: 'short',
        include_actions: true,
      };
      await queue.enqueue('summary', payload);
      await queue.flushDueJobs();
    } catch (error) {
      setErrorText(`Falha ao enfileirar resumo: ${mapApiError(error)}`);
    }
  };

  const handleEnqueueReport = async () => {
    if (!consentGranted) {
      setErrorText('Consentimento obrigatorio para gerar relatorio.');
      return;
    }

    setErrorText('');
    setStatusText('');
    try {
      const payload: ReportRequest = {
        conversation: conversationRef,
        report_type: 'timeline',
        page: 1,
        page_size: 20,
      };
      await queue.enqueue('report', payload);
      await queue.flushDueJobs();
    } catch (error) {
      setErrorText(`Falha ao enfileirar relatorio: ${mapApiError(error)}`);
    }
  };

  const handleRetryFailedJobs = async () => {
    setErrorText('');
    setStatusText('');
    try {
      const retried = await queue.retryFailedJobs();
      if (retried === 0) {
        setStatusText('Nao ha jobs falhos para reprocessar.');
        return;
      }
      await queue.flushDueJobs();
      setStatusText(`${retried} job(s) falho(s) movido(s) para retry.`);
    } catch (error) {
      setErrorText(`Falha ao reprocessar jobs: ${mapApiError(error)}`);
    }
  };

  const handleClearConversation = async () => {
    setErrorText('');
    setStatusText('');
    try {
      await clearConversationData(conversationId);
      setSuggestions([]);
      setSuggestionsQuality(null);
      setMessageCount(0);
      initialContextCapturedRef.current = false;
      setInitialContextCaptured(false);
      setInitialContextMessages([]);
      setStatusText('Dados locais da conversa removidos.');
    } catch (error) {
      setErrorText(`Falha ao limpar dados locais: ${mapApiError(error)}`);
    }
  };

  const handleGrantConsentClick = async () => {
    setUpdatingConsent(true);
    setErrorText('');
    setStatusText('');
    try {
      await onGrantConsent();
      setStatusText('Consentimento concedido. Captura de conversa habilitada.');
    } catch (error) {
      setErrorText(`Falha ao conceder consentimento: ${mapApiError(error)}`);
    } finally {
      setUpdatingConsent(false);
    }
  };

  const handleRevokeConsentClick = async () => {
    setUpdatingConsent(true);
    setErrorText('');
    setStatusText('');
    try {
      await onRevokeConsent();
      setStatusText('Consentimento revogado. Captura de conversa desabilitada.');
    } catch (error) {
      setErrorText(`Falha ao revogar consentimento: ${mapApiError(error)}`);
    } finally {
      setUpdatingConsent(false);
    }
  };

  const conversationLabel = conversationTitle || formatConversationLabel(conversationId);
  const conversationDisplayLabel = conversationOpen
    ? conversationLabel
    : 'Nenhuma conversa aberta';
  const qualityLabel =
    typeof suggestionsQuality === 'number'
      ? `${(suggestionsQuality * 100).toFixed(0)}%`
      : '--';
  const contextMessageCount = initialContextCaptured
    ? initialContextMessages.length
    : messageCount;
  const canGenerateSuggestions =
    (consentGranted || contextMessageCount > 0) &&
    conversationOpen &&
    !loadingSuggestions;
  const suggestionsPrerequisite = !conversationOpen
    ? 'Abra uma conversa no WhatsApp para habilitar sugestoes.'
    : initialContextCaptured
      ? `Contexto inicial fixo: ${contextMessageCount} mensagem(ns) carregada(s).`
      : `Contexto disponivel: ${contextMessageCount} mensagem(ns) lida(s).`;

  return (
    <section className="wa-shell">
      <header className="wa-card wa-header">
        <div>
          <p className="wa-eyebrow">Assistente de Conversa</p>
          <h1 className="wa-brand-title">WA Copilot</h1>
          <p className="wa-subtitle">Resumo, resposta e relatorios com HITL.</p>
        </div>
        <div className="wa-header-badges">
          <span className="wa-pill">P7</span>
          <span className={`wa-pill ${consentGranted ? 'wa-pill--ok' : 'wa-pill--warning'}`}>
            {consentGranted ? 'captura ativa' : 'captura pausada'}
          </span>
        </div>
      </header>

      <section className="wa-card wa-card--elevated">
        <div className="wa-card-head">
          <span className="wa-label">Conversa atual</span>
          <h2 className="wa-conversation-title">{conversationDisplayLabel}</h2>
        </div>
        <div className="wa-metric-grid">
          <article className="wa-metric-card">
            <span className="wa-metric-label">
              {initialContextCaptured ? 'Msgs contexto inicial' : 'Mensagens'}
            </span>
            <strong className="wa-metric-value">{contextMessageCount}</strong>
          </article>
          <article className="wa-metric-card">
            <span className="wa-metric-label">Fila pendente</span>
            <strong className="wa-metric-value">{queuePending}</strong>
          </article>
          <article className="wa-metric-card">
            <span className="wa-metric-label">Fila falha</span>
            <strong className="wa-metric-value">{queueFailed}</strong>
          </article>
          <article className="wa-metric-card">
            <span className="wa-metric-label">Qualidade IA</span>
            <strong className="wa-metric-value">{qualityLabel}</strong>
          </article>
        </div>
      </section>

      <section className="wa-card">
        <div className="wa-card-head">
          <h3 className="wa-section-title">Privacidade</h3>
          <p className="wa-section-copy">
            Captura so ocorre com consentimento explicito e pode ser revogada a qualquer momento.
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            void (consentGranted ? handleRevokeConsentClick() : handleGrantConsentClick())
          }
          disabled={updatingConsent}
          className={`wa-btn ${consentGranted ? 'wa-btn--danger' : 'wa-btn--primary'} wa-btn--lg`}
        >
          {updatingConsent
            ? 'Aplicando...'
            : consentGranted
              ? 'Revogar consentimento'
              : 'Conceder consentimento'}
        </button>
      </section>

      <section className="wa-card">
        <div className="wa-card-head">
          <h3 className="wa-section-title">Configuracao de resposta</h3>
          <p className="wa-section-copy">
            Ajuste tom, idioma e janela para refletir o contexto real da conversa.
          </p>
        </div>

        <div className="wa-field-grid">
          <label className="wa-field">
            <span className="wa-field-label">Tom</span>
            <select
              value={tone}
              onChange={(event) => setTone(event.target.value as Tone)}
              className="wa-select"
            >
              <option value="formal">Formal</option>
              <option value="neutro">Neutro</option>
              <option value="amigavel">Amigavel</option>
            </select>
          </label>

          <label className="wa-field">
            <span className="wa-field-label">Idioma</span>
            <input
              value={locale}
              onChange={(event) => setLocale(event.target.value)}
              placeholder="pt-BR"
              className="wa-input"
            />
          </label>
        </div>

        <label className="wa-field">
          <div className="wa-range-head">
            <span className="wa-field-label">Janela de contexto</span>
            <span className="wa-range-value">{contextWindow} msgs</span>
          </div>
          <input
            type="range"
            min={MIN_CONTEXT_WINDOW}
            max={MAX_CONTEXT_WINDOW}
            value={contextWindow}
            onChange={(event) =>
              setContextWindow(clampContextWindow(Number(event.target.value)))
            }
            className="wa-range"
          />
          <input
            type="number"
            value={contextWindow}
            min={MIN_CONTEXT_WINDOW}
            max={MAX_CONTEXT_WINDOW}
            onChange={(event) =>
              setContextWindow(clampContextWindow(Number(event.target.value)))
            }
            className="wa-input wa-input--compact"
          />
        </label>
      </section>

      <section className="wa-card">
        <div className="wa-card-head">
          <h3 className="wa-section-title">Acoes</h3>
          <p className="wa-section-copy">
            Geracao assistida com fila para resumo e relatorios.
          </p>
          <p className="wa-section-copy">{suggestionsPrerequisite}</p>
        </div>
        <div className="wa-action-grid">
          <button
            type="button"
            onClick={() => void handleGenerateSuggestions()}
            disabled={!canGenerateSuggestions}
            className="wa-btn wa-btn--primary wa-btn--lg"
          >
            {loadingSuggestions ? 'Gerando sugestoes...' : 'Gerar sugestoes'}
          </button>

          <button
            type="button"
            onClick={() => void handleEnqueueSummary()}
            disabled={!consentGranted}
            className="wa-btn wa-btn--secondary"
          >
            Enfileirar resumo
          </button>

          <button
            type="button"
            onClick={() => void handleEnqueueReport()}
            disabled={!consentGranted}
            className="wa-btn wa-btn--secondary"
          >
            Enfileirar relatorio
          </button>

          {queueFailed > 0 ? (
            <button
              type="button"
              onClick={() => void handleRetryFailedJobs()}
              className="wa-btn wa-btn--warning"
            >
              Reprocessar jobs falhos
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => void handleClearConversation()}
            className="wa-btn wa-btn--ghost"
          >
            Limpar dados locais da conversa
          </button>
        </div>
      </section>

      <section className="wa-card wa-card--soft">
        <div className="wa-card-head">
          <h3 className="wa-section-title">Sugestoes</h3>
          <p className="wa-section-copy">
            {hitlRequired
              ? 'HITL obrigatorio: copia ou insercao exigem confirmacao dupla.'
              : 'HITL retornado como opcional pelo backend.'}
          </p>
        </div>

        {suggestions.length === 0 ? (
          <div className="wa-empty-state">
            <strong>Nenhuma sugestao gerada</strong>
            <span>
              {conversationOpen
                ? initialContextCaptured
                  ? 'A IA usa o contexto inicial carregado ao abrir a conversa.'
                  : 'A IA gera respostas a partir das mensagens recentes da conversa aberta.'
                : 'Abra uma conversa para permitir leitura de contexto e geracao de resposta.'}
            </span>
          </div>
        ) : (
          <ol className="wa-suggestions-list">
            {suggestions.map((candidate) => (
              <li key={candidate.rank} className="wa-suggestion-item">
                <div className="wa-suggestion-head">
                  <span className="wa-rank">#{candidate.rank}</span>
                  <span className="wa-suggestion-meta">Pronta para revisar e enviar</span>
                </div>
                <p className="wa-suggestion-content">{candidate.content}</p>
                {candidate.rationale ? (
                  <p className="wa-suggestion-rationale">Motivo: {candidate.rationale}</p>
                ) : null}
                <SendGuard
                  disabled={!consentGranted}
                  onCopy={() => handleCopySuggestion(candidate.content)}
                  onInsert={() => handleInsertSuggestion(candidate.content)}
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      {errorText ? (
        <div className="wa-status-banner wa-status-banner--error">
          <span>{errorText}</span>
          <button
            type="button"
            onClick={() => void handleGenerateSuggestions()}
            disabled={!canGenerateSuggestions}
            className="wa-btn wa-btn--ghost"
          >
            Tentar novamente
          </button>
        </div>
      ) : null}

      {statusText ? (
        <div className="wa-status-banner wa-status-banner--success">{statusText}</div>
      ) : null}
    </section>
  );
}

export default SidebarApp;
