import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AgentItem } from '../api'
import { Markdownish } from './Markdownish'
import { ResultTable } from './ResultTable'
import { SqlPanel } from './SqlPanel'

export interface AgentTurn {
  id: string
  question: string
  items: AgentItem[]
  done: boolean
  error?: { error: string; type?: string }
  startedAt: number
  finishedAt?: number
}

export function AgentChat({
  turns,
  busy,
  maxChars,
  onAsk,
  onClear,
}: {
  turns: AgentTurn[]
  busy: boolean
  maxChars: number
  onAsk: (q: string) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const q = draft.trim()
    if (!q || busy) return
    setDraft('')
    onAsk(q)
  }

  return (
    <div className="chat">
      <p className="muted small">
        Preview API — documented but still Preview. Follow-up questions continue the same agent conversation.
      </p>
      <div className="turns">
        {turns.map((t) => <AgentTurnView key={t.id} turn={t} />)}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          maxLength={maxChars}
          placeholder="Ask the agent to research a NEM question…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(e)
            }
          }}
          rows={2}
          disabled={busy}
        />
        <div className="composer-actions">
          <span className="muted small">{draft.length}/{maxChars}</span>
          {turns.length > 0 && <button type="button" className="linkish" onClick={onClear} disabled={busy}>Clear transcript</button>}
          <button type="submit" disabled={busy || !draft.trim()}>{busy ? 'Working…' : 'Ask'}</button>
        </div>
      </form>
    </div>
  )
}

function AgentTurnView({ turn }: { turn: AgentTurn }) {
  const secs = ((turn.finishedAt ?? turn.startedAt) - turn.startedAt) / 1000
  return (
    <article className="turn">
      <div className="bubble user">{turn.question}</div>
      <div className="answer">
        {turn.items.map((item) => <AgentItemView key={item.id} item={item} />)}
        {!turn.done && !turn.error && <div className="skeleton" />}
        {turn.error && (
          <div className="alert" role="alert">
            <strong>{turn.error.type ?? 'Error'}</strong>
            <div className="small pre">{turn.error.error}</div>
          </div>
        )}
        {turn.done && !turn.error && (
          <footer className="muted small answer-foot">
            AI-generated, including the reasoning above; verify before relying on it. {secs.toFixed(1)}s.
          </footer>
        )}
      </div>
    </article>
  )
}

function AgentItemView({ item }: { item: AgentItem }) {
  if (item.kind === 'reasoning') {
    return <p className="muted small agent-reasoning">💭 {item.reasoningText}</p>
  }
  if (item.kind === 'sql_call' && item.sqlCall) {
    return <SqlPanel sql={item.sqlCall.sql} description={item.sqlCall.title} curated={false} />
  }
  if (item.kind === 'message') {
    return (
      <>
        {(item.messageParts ?? []).map((part, i) =>
          part.table ? (
            <div key={i}>
              {part.tableCaption && <p className="muted small">{part.tableCaption}</p>}
              <ResultTable
                result={{
                  attachmentId: `${item.id}-${i}`,
                  columns: part.table.columns,
                  rows: part.table.rows,
                  totalRowCount: part.table.totalRowCount,
                  truncated: part.table.truncated,
                }}
              />
            </div>
          ) : (
            <Markdownish key={i} text={part.text} />
          ),
        )}
      </>
    )
  }
  return null
}
