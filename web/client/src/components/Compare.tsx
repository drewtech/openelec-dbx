export type Mode = 'compare' | 'chat' | 'agent'

interface Row {
  key: 'chat' | 'agent'
  title: string
  where: string
  anonymous: boolean
  identity: string
  richness: string
  pros: string[]
  cons: string[]
}

function rows(): Row[] {
  return [
    {
      key: 'chat',
      title: 'Chat mode — Genie Conversation API',
      where: 'This site + a Node proxy you own',
      anonymous: true,
      identity: 'One shared token (the proxy’s)',
      richness: 'Text + one SQL query + a result table, with follow-ups',
      pros: [
        'Anonymous visitors — no Databricks login at all',
        'Full control over rate limiting, UI, and what gets shown',
        'Databricks’ own docs point external-user scenarios here',
      ],
      cons: [
        'One shared identity: no row-level security or per-visitor audit trail',
        '5 questions/min per workspace, shared with every other demo here',
        'You own the SSE plumbing and the security of the token',
      ],
    },
    {
      key: 'agent',
      title: 'Agent mode — Preview Agent API',
      where: 'This site + the same Node proxy',
      anonymous: true,
      identity: 'Same shared token as chat mode',
      richness: 'Reasoning steps, multiple SQL calls, a narrative answer, with follow-ups',
      pros: [
        'Closer to a research assistant than a Q&A box',
        'Same anonymous-visitor story as chat mode',
        'Reuses the same proxy, rate limiter, and token',
      ],
      cons: [
        'Preview API — documented, but can still change without notice',
        'Preview: admin-gated on some workspaces (not gated here, confirmed live)',
        'No `type_name` on result columns, unlike chat mode’s statement API',
      ],
    },
  ]
}

export function Compare({ onTry }: { onTry: (mode: Mode) => void }) {
  return (
    <div className="chat">
      <section className="panel">
        <p className="muted small" style={{ margin: 0 }}>
          Two ways to put this Genie space in front of an anonymous visitor, tried and run live against this
          workspace. A Databricks App and the official iframe embed are the other two ways to expose a Genie
          space — see <code>web/README.md</code> — but both require a Databricks login, so they're not part of
          this site. Pick a row to try it.
        </p>
      </section>
      {rows().map((r) => (
        <section key={r.key} className="panel">
          <header className="panel-head">
            <strong>{r.title}</strong>
            <span className={`badge ${r.anonymous ? 'badge-good' : 'badge-warn'}`}>
              {r.anonymous ? 'Anonymous OK' : 'Login required'}
            </span>
          </header>
          <p className="muted small" style={{ margin: '0.3rem 0' }}>
            {r.where} · {r.identity} · {r.richness}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.8rem', marginTop: '0.5rem' }}>
            <div>
              <p className="small" style={{ margin: '0 0 0.2rem', fontWeight: 600 }}>Pros</p>
              <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {r.pros.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
            <div>
              <p className="small" style={{ margin: '0 0 0.2rem', fontWeight: 600 }}>Cons</p>
              <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {r.cons.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
          </div>
          <div style={{ marginTop: '0.7rem' }}>
            <button className="linkish" onClick={() => onTry(r.key)}>Try it →</button>
          </div>
        </section>
      ))}
    </div>
  )
}
