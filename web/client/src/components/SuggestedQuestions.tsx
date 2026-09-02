export function SuggestedQuestions({ questions, onPick, disabled, title }: { questions: string[]; onPick: (q: string) => void; disabled: boolean; title: string }) {
  if (!questions.length) return null
  return (
    <div className="suggestions">
      <span className="muted small">{title}</span>
      <div className="chips">
        {questions.map((q) => (
          <button key={q} className="chip" disabled={disabled} onClick={() => onPick(q)}>{q}</button>
        ))}
      </div>
    </div>
  )
}
