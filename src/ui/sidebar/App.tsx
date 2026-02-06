import { useEffect, useMemo, useState } from 'react';
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
  db: WACopilotDb;
  queue: LocalJobQueue;
  consentGranted: boolean;
  onGrantConsent: () => Promise<void>;
  onRevokeConsent: () => Promise<void>;
}

const sectionStyle: React.CSSProperties = {
  background: '#f6fcf9',
  border: '1px solid #dbebe4',
  borderRadius: 10,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const MIN_CONTEXT_MESSAGES = 12;
const MAX_CONTEXT_MESSAGES = 80;
const MAX_CONTEXT_MESSAGE_CHARS = 360;

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
    if (error.status === 401 || error.status === 403) {
      return 'Falha de autenticacao. Confira o token definido em codigo.';
    }
    if (error.status === 429) {
      return 'Limite de requisicoes atingido. Tente novamente em instantes.';
    }
    if (error.status === 504) {
      return 'Tempo limite excedido ao chamar o backend.';
    }
    return `Erro de API (${error.status}).`;
  }

  if (error instanceof Error) {
    return error.message;
  }
  return 'Erro desconhecido.';
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

  const handleGenerateSuggestions = async () => {
    if (!consentGranted) {
      setErrorText('Consentimento obrigatorio para gerar sugestoes.');
      return;
    }

    setLoadingSuggestions(true);
    setErrorText('');
    setStatusText('');

    try {
      const [apiClient, recentMessages] = await Promise.all([
        createApiClient(),
        listMessagesByConversation(
          conversationId,
          deriveSuggestionMessageLimit(contextWindow),
        ),
      ]);
      const contextMessages = recentMessages
        .map((message) => formatMessageForSuggestionContext(message))
        .filter((message) => message.length > 0);
      const response = await apiClient.createSuggestions({
        conversation: conversationRef,
        locale,
        tone,
        context_window: contextWindow,
        messages: contextMessages,
        max_candidates: 3,
        include_last_user_message: true,
      });
      setSuggestions(response.suggestions);
      setSuggestionsQuality(
        typeof response.quality_score === 'number' ? response.quality_score : null,
      );
      setHitlRequired(response.hitl_required !== false);
      setStatusText('Sugestoes geradas com sucesso.');
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

  return (
    <section
      style={{
        background: '#ffffff',
        border: '1px solid #d8ebe4',
        borderRadius: 12,
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.12)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <strong style={{ color: '#0f5136' }}>WA Copilot</strong>
        <span style={{ fontSize: 12, color: '#355d4b' }}>P5 Guardrails</span>
      </header>

      <div style={sectionStyle}>
        <strong style={{ fontSize: 13 }}>Consentimento</strong>
        <span style={{ fontSize: 12, color: '#355d4b' }}>
          {consentGranted
            ? 'Ativo: leitura de conversa habilitada.'
            : 'Inativo: leitura de conversa bloqueada.'}
        </span>
        {!consentGranted ? (
          <button
            type="button"
            onClick={() => void handleGrantConsentClick()}
            disabled={updatingConsent}
            style={{
              height: 34,
              borderRadius: 8,
              border: 'none',
              background: '#0f9960',
              color: '#ffffff',
              cursor: 'pointer',
            }}
          >
            {updatingConsent ? 'Aplicando...' : 'Conceder consentimento'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleRevokeConsentClick()}
            disabled={updatingConsent}
            style={{
              height: 34,
              borderRadius: 8,
              border: '1px solid #d7a2a2',
              background: '#fff5f5',
              cursor: 'pointer',
            }}
          >
            {updatingConsent ? 'Aplicando...' : 'Revogar consentimento'}
          </button>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={{ fontSize: 12, color: '#355d4b' }}>
          Conversa:{' '}
          <strong>{conversationTitle || formatConversationLabel(conversationId)}</strong>
        </div>
        <div style={{ fontSize: 12, color: '#355d4b' }}>
          Mensagens capturadas: <strong>{messageCount}</strong>
        </div>
        <div style={{ fontSize: 12, color: '#355d4b' }}>
          Jobs pendentes: <strong>{queuePending}</strong> | falhos:{' '}
          <strong>{queueFailed}</strong>
        </div>
      </div>

      <div style={sectionStyle}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12 }}>Tom</span>
          <select
            value={tone}
            onChange={(event) => setTone(event.target.value as Tone)}
            style={{ height: 32 }}
          >
            <option value="formal">Formal</option>
            <option value="neutro">Neutro</option>
            <option value="amigavel">Amigavel</option>
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12 }}>Idioma</span>
          <input
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
            placeholder="pt-BR"
            style={{ height: 30, padding: '0 8px' }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12 }}>Janela de contexto</span>
          <input
            type="number"
            value={contextWindow}
            min={5}
            max={80}
            onChange={(event) => {
              const next = Number(event.target.value);
              setContextWindow(Number.isNaN(next) ? 20 : next);
            }}
            style={{ height: 30, padding: '0 8px' }}
          />
        </label>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <button
          type="button"
          onClick={() => void handleGenerateSuggestions()}
          disabled={loadingSuggestions || !consentGranted}
          style={{
            height: 34,
            borderRadius: 8,
            border: 'none',
            background: '#0f9960',
            color: '#ffffff',
            cursor: 'pointer',
            opacity: consentGranted ? 1 : 0.6,
          }}
        >
          {loadingSuggestions ? 'Gerando...' : 'Gerar sugestoes'}
        </button>
        <button
          type="button"
          onClick={() => void handleEnqueueSummary()}
          disabled={!consentGranted}
          style={{
            height: 34,
            borderRadius: 8,
            border: '1px solid #7fb59d',
            background: '#eef8f3',
            cursor: 'pointer',
            opacity: consentGranted ? 1 : 0.6,
          }}
        >
          Enfileirar resumo
        </button>
        <button
          type="button"
          onClick={() => void handleEnqueueReport()}
          disabled={!consentGranted}
          style={{
            height: 34,
            borderRadius: 8,
            border: '1px solid #7fb59d',
            background: '#eef8f3',
            cursor: 'pointer',
            opacity: consentGranted ? 1 : 0.6,
          }}
        >
          Enfileirar relatorio
        </button>
        {queueFailed > 0 ? (
          <button
            type="button"
            onClick={() => void handleRetryFailedJobs()}
            style={{
              height: 34,
              borderRadius: 8,
              border: '1px solid #d6ac3f',
              background: '#fff8e3',
              cursor: 'pointer',
            }}
          >
            Reprocessar jobs falhos
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void handleClearConversation()}
          style={{
            height: 34,
            borderRadius: 8,
            border: '1px solid #d7a2a2',
            background: '#fff5f5',
            cursor: 'pointer',
          }}
        >
          Limpar dados locais da conversa
        </button>
      </div>

      <div style={sectionStyle}>
        <strong style={{ fontSize: 13 }}>Sugestoes</strong>
        <span style={{ fontSize: 11, color: '#355d4b' }}>
          {hitlRequired
            ? 'HITL obrigatorio: copiar/inserir exige confirmacao dupla.'
            : 'HITL reportado como opcional pelo backend.'}
          {typeof suggestionsQuality === 'number'
            ? ` Qualidade: ${(suggestionsQuality * 100).toFixed(0)}%.`
            : ''}
        </span>
        {suggestions.length === 0 ? (
          <span style={{ fontSize: 12, color: '#5a7467' }}>
            Nenhuma sugestao gerada.
          </span>
        ) : (
          <ol style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 6 }}>
            {suggestions.map((candidate) => (
              <li
                key={candidate.rank}
                style={{
                  fontSize: 12,
                  lineHeight: 1.4,
                  display: 'grid',
                  gap: 6,
                  paddingBottom: 4,
                }}
              >
                <span>{candidate.content}</span>
                {candidate.rationale ? (
                  <span style={{ fontSize: 11, color: '#5a7467' }}>
                    {candidate.rationale}
                  </span>
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
      </div>

      {errorText ? (
        <div
          style={{
            borderRadius: 8,
            border: '1px solid #f0b6b6',
            padding: '8px 10px',
            fontSize: 12,
            background: '#fff4f4',
            color: '#8c1d1d',
            display: 'grid',
            gap: 8,
          }}
        >
          <span>{errorText}</span>
          <button
            type="button"
            onClick={() => void handleGenerateSuggestions()}
            disabled={!consentGranted || loadingSuggestions}
            style={{
              height: 30,
              borderRadius: 8,
              border: '1px solid #d7a2a2',
              background: '#ffffff',
              cursor: 'pointer',
              opacity: consentGranted ? 1 : 0.5,
            }}
          >
            Tentar novamente sugestoes
          </button>
        </div>
      ) : null}

      {statusText ? (
        <div
          style={{
            borderRadius: 8,
            border: '1px solid #d8ebe4',
            padding: '8px 10px',
            fontSize: 12,
            background: '#f8fffb',
            color: '#184d36',
          }}
        >
          {statusText}
        </div>
      ) : null}
    </section>
  );
}

export default SidebarApp;
