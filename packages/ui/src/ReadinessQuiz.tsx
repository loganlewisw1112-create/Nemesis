import { useState } from 'react';

const QUESTIONS = [
  {
    q: 'What must pass before enabling live trading?',
    options: ['Any single gate', 'All 8 guardrail gates', 'Only the quiz', 'Only backtest'],
    answer: 1,
  },
  {
    q: 'What does the kill switch do?',
    options: ['Deletes journal', 'Disables live and halts new live orders', 'Resets paper wallet', 'Closes the app'],
    answer: 1,
  },
  {
    q: 'Paper fills should simulate…',
    options: ['Instant mid price only', 'Orderbook walk with slippage limits', 'Random prices', 'No fees'],
    answer: 1,
  },
  {
    q: 'Daily loss cap applies to…',
    options: ['Journal count only', 'Paper and live P&L tracking', 'Connector latency', 'Spread only'],
    answer: 1,
  },
  {
    q: 'Before live, you should use…',
    options: ['Production API keys on main account', 'Dedicated test keys and dry-run first', 'Shared team keys in chat', 'No keys'],
    answer: 1,
  },
];

interface Props {
  onPass: () => void;
  alreadyPassed?: boolean;
}

export function ReadinessQuiz({ onPass, alreadyPassed }: Props) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);

  if (alreadyPassed) {
    return <div style={{ fontSize: 12, color: 'var(--success)' }}>Readiness quiz passed.</div>;
  }

  const score = QUESTIONS.filter((_, i) => answers[i] === QUESTIONS[i].answer).length;
  const passed = submitted && score === QUESTIONS.length;

  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Human readiness quiz</div>
      {QUESTIONS.map((item, i) => (
        <div key={item.q} style={{ marginBottom: 10 }}>
          <div style={{ marginBottom: 4 }}>{i + 1}. {item.q}</div>
          {item.options.map((opt, j) => (
            <label key={opt} style={{ display: 'block', marginBottom: 2, cursor: 'pointer' }}>
              <input
                type="radio"
                name={`q-${i}`}
                checked={answers[i] === j}
                onChange={() => setAnswers((prev) => ({ ...prev, [i]: j }))}
              />{' '}
              {opt}
            </label>
          ))}
        </div>
      ))}
      <button
        type="button"
        style={btnStyle}
        onClick={() => {
          const s = QUESTIONS.filter((_, i) => answers[i] === QUESTIONS[i].answer).length;
          setSubmitted(true);
          if (s === QUESTIONS.length) onPass();
        }}
      >
        Submit quiz
      </button>
      {submitted && (
        <div style={{ marginTop: 8, color: passed ? 'var(--success)' : 'var(--danger)' }}>
          {passed ? 'All correct — gate passed.' : `${score}/${QUESTIONS.length} correct — review and retry.`}
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'var(--accent)',
  border: 'none',
  color: '#fff',
  padding: '6px 12px',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
};
