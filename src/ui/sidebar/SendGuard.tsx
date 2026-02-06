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
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => requestAction('copy')}
          disabled={disabled || running}
          style={{
            height: 28,
            padding: '0 10px',
            borderRadius: 7,
            border: pendingAction === 'copy' ? '1px solid #c88f00' : '1px solid #7fb59d',
            background: pendingAction === 'copy' ? '#fff8e3' : '#eef8f3',
            cursor: disabled || running ? 'not-allowed' : 'pointer',
          }}
        >
          {pendingAction === 'copy' ? 'Confirmar copia' : 'Copiar'}
        </button>

        <button
          type="button"
          onClick={() => requestAction('insert')}
          disabled={disabled || running}
          style={{
            height: 28,
            padding: '0 10px',
            borderRadius: 7,
            border: pendingAction === 'insert' ? '1px solid #c88f00' : '1px solid #7fb59d',
            background: pendingAction === 'insert' ? '#fff8e3' : '#eef8f3',
            cursor: disabled || running ? 'not-allowed' : 'pointer',
          }}
        >
          {pendingAction === 'insert' ? 'Confirmar insercao' : 'Inserir no campo'}
        </button>
      </div>

      <span style={{ fontSize: 11, color: '#355d4b' }}>
        HITL ativo: a extensao nunca envia mensagens automaticamente.
      </span>

      {feedback ? (
        <span style={{ fontSize: 11, color: feedbackError ? '#8c1d1d' : '#184d36' }}>
          {feedback}
        </span>
      ) : null}
    </div>
  );
}
