import { useEffect, useState } from 'react';

type GuardAction = 'copy' | 'insert';

interface SendGuardProps {
  disabled?: boolean;
  onCopy: () => Promise<void>;
  onInsert: () => Promise<void>;
}

const GUARD_TIMEOUT_MS = 8000;

function actionLabel(action: GuardAction): string {
  if (action === 'copy') {
    return 'copiar';
  }
  return 'inserir';
}

export default function SendGuard({
  disabled = false,
  onCopy,
  onInsert,
}: SendGuardProps) {
  const [pendingAction, setPendingAction] = useState<GuardAction | null>(null);
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState(false);

  useEffect(() => {
    if (!pendingAction) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setPendingAction(null);
      setFeedback('');
      setFeedbackError(false);
    }, GUARD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingAction]);

  const requestAction = (action: GuardAction) => {
    if (disabled || running) {
      return;
    }

    if (pendingAction !== action) {
      setPendingAction(action);
      setFeedback(`Confirme para ${actionLabel(action)} (2o clique).`);
      setFeedbackError(false);
      return;
    }

    setRunning(true);
    setFeedback('');
    setFeedbackError(false);
    const operation = action === 'copy' ? onCopy : onInsert;
    void operation()
      .then(() => {
        setFeedback(
          action === 'copy'
            ? 'Texto copiado. Revise no WhatsApp antes de enviar.'
            : 'Texto inserido no campo. Revise e envie manualmente.',
        );
      })
      .catch((error: unknown) => {
        setFeedback(error instanceof Error ? error.message : 'Falha ao aplicar acao.');
        setFeedbackError(true);
      })
      .finally(() => {
        setRunning(false);
        setPendingAction(null);
      });
  };

  return (
    <div className="wa-guard">
      <div className="wa-guard-actions">
        <button
          type="button"
          onClick={() => requestAction('copy')}
          disabled={disabled || running}
          className={`wa-btn wa-btn--tiny ${
            pendingAction === 'copy' ? 'wa-btn--warning' : 'wa-btn--subtle'
          }`}
        >
          {pendingAction === 'copy' ? 'Confirmar copia' : 'Copiar'}
        </button>

        <button
          type="button"
          onClick={() => requestAction('insert')}
          disabled={disabled || running}
          className={`wa-btn wa-btn--tiny ${
            pendingAction === 'insert' ? 'wa-btn--warning' : 'wa-btn--subtle'
          }`}
        >
          {pendingAction === 'insert' ? 'Confirmar insercao' : 'Inserir no campo'}
        </button>
      </div>

      <span className="wa-guard-note">
        HITL ativo: a extensao nunca envia mensagens automaticamente.
      </span>

      {feedback ? (
        <span
          className={`wa-guard-feedback ${
            feedbackError ? 'wa-guard-feedback--error' : 'wa-guard-feedback--ok'
          }`}
        >
          {feedback}
        </span>
      ) : null}
    </div>
  );
}
