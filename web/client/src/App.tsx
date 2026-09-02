import { useEffect, useRef, useState } from 'react'
import { getSpace, streamAgentResponse, streamMessage, type AgentItem, type SpaceInfo } from './api'
import { AgentChat, type AgentTurn } from './components/AgentChat'
import { Chat, type Turn } from './components/Chat'
import { Compare, type Mode } from './components/Compare'
import { SuggestedQuestions } from './components/SuggestedQuestions'

export default function App() {
  const [space, setSpace] = useState<SpaceInfo>()
  const [spaceError, setSpaceError] = useState<string>()
  const [mode, setMode] = useState<Mode>('compare')

  // Chat mode state
  const [turns, setTurns] = useState<Turn[]>([])
  const [conversationId, setConversationId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController>(null)

  // Agent mode state (Preview) — kept separate: different event shapes, own conversation id.
  const [agentTurns, setAgentTurns] = useState<AgentTurn[]>([])
  const [agentConversationId, setAgentConversationId] = useState<string>()
  const [agentBusy, setAgentBusy] = useState(false)
  const agentAbort = useRef<AbortController>(null)

  useEffect(() => {
    getSpace().then(setSpace).catch((e: Error) => setSpaceError(e.message))
  }, [])

  const patch = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)))

  const ask = async (question: string) => {
    if (busy) return
    const id = crypto.randomUUID()
    setTurns((ts) => [...ts, { id, question, status: 'SUBMITTED', attachments: [], results: {}, startedAt: Date.now() }])
    setBusy(true)
    abort.current = new AbortController()
    try {
      await streamMessage(question, conversationId, (evt) => {
        switch (evt.event) {
          case 'message_start':
            setConversationId(evt.data.conversationId)
            break
          case 'status':
            patch(id, (t) => ({ ...t, status: evt.data.status }))
            break
          case 'query_result':
            patch(id, (t) => ({ ...t, results: { ...t.results, [evt.data.attachmentId]: evt.data } }))
            break
          case 'message_result':
            patch(id, (t) => ({ ...t, status: 'COMPLETED', content: evt.data.content, attachments: evt.data.attachments, finishedAt: Date.now() }))
            break
          case 'error':
            patch(id, (t) => ({ ...t, error: evt.data, finishedAt: Date.now() }))
            break
        }
      }, abort.current.signal)
    } catch (e) {
      patch(id, (t) => ({ ...t, error: { error: (e as Error).message, type: 'NETWORK' }, finishedAt: Date.now() }))
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    abort.current?.abort()
    setTurns([])
    setConversationId(undefined)
  }

  const patchAgent = (id: string, fn: (t: AgentTurn) => AgentTurn) =>
    setAgentTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)))

  const askAgent = async (question: string) => {
    if (agentBusy) return
    const id = crypto.randomUUID()
    setAgentTurns((ts) => [...ts, { id, question, items: [], done: false, startedAt: Date.now() }])
    setAgentBusy(true)
    agentAbort.current = new AbortController()
    const items: AgentItem[] = []
    try {
      await streamAgentResponse(question, agentConversationId, (evt) => {
        switch (evt.event) {
          case 'agent_start':
            setAgentConversationId(evt.data.conversationId)
            break
          case 'agent_item':
            items.push(evt.data)
            patchAgent(id, (t) => ({ ...t, items: [...items] }))
            break
          case 'agent_done':
            patchAgent(id, (t) => ({ ...t, done: true, finishedAt: Date.now() }))
            break
          case 'error':
            patchAgent(id, (t) => ({ ...t, done: true, error: evt.data, finishedAt: Date.now() }))
            break
        }
      }, agentAbort.current.signal)
    } catch (e) {
      patchAgent(id, (t) => ({ ...t, done: true, error: { error: (e as Error).message, type: 'NETWORK' }, finishedAt: Date.now() }))
    } finally {
      setAgentBusy(false)
    }
  }

  const clearAgent = () => {
    agentAbort.current?.abort()
    setAgentTurns([])
    setAgentConversationId(undefined)
  }

  const busyNow = mode === 'chat' ? busy : mode === 'agent' ? agentBusy : false

  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>⚡ {space?.title ?? 'OpenElectricity Genie'}</h1>
          <p className="muted">{space?.description ?? 'Natural-language questions over Australian NEM data, answered by a Databricks Genie space.'}</p>
        </div>
        <div className="top-right">
          {(mode === 'chat' || mode === 'agent') && (
            <span className="badge badge-warn" title={space?.identity.note}>Runs as shared demo identity</span>
          )}
          {space && (mode === 'chat' || mode === 'agent') && (
            <span className="badge" title="Proxy rate limit; Databricks caps the API at 5/min per workspace">{space.limits.questionsPerMinute} questions/min</span>
          )}
        </div>
      </header>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === 'compare'} className={`tab ${mode === 'compare' ? 'tab-active' : ''}`} onClick={() => setMode('compare')} disabled={busyNow}>
          Compare
        </button>
        <button role="tab" aria-selected={mode === 'chat'} className={`tab ${mode === 'chat' ? 'tab-active' : ''}`} onClick={() => setMode('chat')} disabled={busyNow}>
          Chat mode
        </button>
        <button role="tab" aria-selected={mode === 'agent'} className={`tab ${mode === 'agent' ? 'tab-active' : ''}`} onClick={() => setMode('agent')} disabled={busyNow} title="Preview API — see web/README.md">
          Agent mode <span className="badge badge-warn tab-badge">Preview</span>
        </button>
      </div>

      {spaceError && <div className="alert">Proxy unreachable: {spaceError}. Is <code>npm run dev</code> running with Databricks credentials?</div>}

      <main className="main">
        {mode === 'compare' && <Compare onTry={setMode} />}
        {mode === 'chat' && (
          <>
            {turns.length === 0 && space && (
              <section className="empty">
                <h2>Try one of these</h2>
                <SuggestedQuestions title="" questions={space.sampleQuestions} onPick={ask} disabled={busy} />
                <details>
                  <summary className="muted small">Tables this space can query ({space.tables.length})</summary>
                  <ul className="small mono">{space.tables.map((t) => <li key={t}>{t}</li>)}</ul>
                </details>
                <p className="muted small">{space.identity.note} Answers take 5 to 30 seconds, longer on a cold warehouse.</p>
              </section>
            )}
            <Chat turns={turns} busy={busy} maxChars={space?.limits.maxQuestionChars ?? 500} onAsk={ask} onReset={reset} />
          </>
        )}
        {mode === 'agent' && (
          <>
            {agentTurns.length === 0 && space && (
              <section className="empty">
                <h2>Try one of these</h2>
                <SuggestedQuestions title="" questions={space.sampleQuestions} onPick={askAgent} disabled={agentBusy} />
                <p className="muted small">
                  Agent mode narrates its own reasoning and can run more than one query per question. {space.identity.note}
                </p>
              </section>
            )}
            <AgentChat turns={agentTurns} busy={agentBusy} maxChars={space?.limits.maxQuestionChars ?? 500} onAsk={askAgent} onClear={clearAgent} />
          </>
        )}
      </main>

      <footer className="foot muted small">
        {mode === 'compare' && <>web/'s own chat + agent modes against the same Genie space; see web/README.md for the App and embed options.</>}
        {mode === 'chat' && <>Genie Conversation API via a local Node proxy. Conversation {conversationId ? <code>{conversationId.slice(0, 8)}…</code> : 'not started'}.</>}
        {mode === 'agent' && (
          <>
            Genie Agent mode API (Preview) via a local Node proxy. Conversation{' '}
            {agentConversationId ? <code>{agentConversationId.slice(0, 8)}…</code> : 'not started'}.
          </>
        )}
      </footer>
    </div>
  )
}
