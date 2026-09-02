import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { NormalizedAttachment, QueryResultPayload } from '../api'
import { ResultTable } from './ResultTable'
import { SqlPanel } from './SqlPanel'
import { StatusStepper } from './StatusStepper'
import { SuggestedQuestions } from './SuggestedQuestions'

export interface Turn {
  id: string
  question: string
  status: string
  content?: string
  attachments: NormalizedAttachment[]
  results: Record<string, QueryResultPayload>
  error?: { error: string; type?: string }
  startedAt: number
  finishedAt?: number
}

export function Chat({ turns, busy, maxChars, onAsk, onReset }: { turns: Turn[]; busy: boolean; maxChars: number; onAsk: (q: string) => void; onReset: () => void }) {
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
  const lastTurn = turns[turns.length - 1]
  const followUps = lastTurn?.attachments.find((a) => a.kind === 'suggested_questions')?.questions ?? []

  return (
    <div className="chat">
      <div className="turns">
        {turns.map((t) => <TurnView key={t.id} turn={t} />)}
        {followUps.length > 0 && !busy && (
          <SuggestedQuestions title="Genie suggests" questions={followUps} onPick={onAsk} disabled={busy} />
        )}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          maxLength={maxChars}
          placeholder="Ask about NEM generation, emissions or capacity…"
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
          {turns.length > 0 && <button type="button" className="linkish" onClick={onReset} disabled={busy}>New conversation</button>}
          <button type="submit" disabled={busy || !draft.trim()}>{busy ? 'Working…' : 'Ask'}</button>
        </div>
      </form>
    </div>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  const done = turn.status === 'COMPLETED' || Boolean(turn.error)
  const secs = ((turn.finishedAt ?? turn.startedAt) - turn.startedAt) / 1000
  const textParts = turn.attachments.filter((a) => a.kind === 'text').map((a) => a.text)
  const queries = turn.attachments.filter((a) => a.kind === 'query')
  return (
    <article className="turn">
      <div className="bubble user">{turn.question}</div>
      <div className="answer">
        {!done && <StatusStepper status={turn.status} />}
        {turn.error && (
          <div className="alert" role="alert">
            <strong>{turn.error.type ?? 'Error'}</strong>
            <div className="small pre">{turn.error.error}</div>
          </div>
        )}
        {textParts.map((t, i) => <p key={i} className="pre">{t}</p>)}
        {queries.map((q) => (
          <div key={q.id}>
            <SqlPanel sql={q.query!.sql} description={q.query!.description} curated={q.query!.curated} curatedTitle={q.query!.curatedTitle} />
            {turn.results[q.id] ? <ResultTable result={turn.results[q.id]} /> : done ? null : <div className="skeleton" />}
          </div>
        ))}
        {done && !turn.error && (
          <footer className="muted small answer-foot">
            AI-generated from the SQL above; verify before relying on it. {secs.toFixed(1)}s.
          </footer>
        )}
      </div>
    </article>
  )
}
