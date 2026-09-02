import { useState } from 'react'

export function SqlPanel({ sql, description, curated, curatedTitle }: { sql: string; description?: string; curated: boolean; curatedTitle?: string }) {
  const [open, setOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <section className="panel">
      <header className="panel-head">
        <button className="linkish" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? '▾' : '▸'} Generated SQL
        </button>
        {curated ? (
          <span className="badge badge-good" title={curatedTitle ? `Trusted asset: ${curatedTitle}` : 'Answered from a curated example query'}>
            Curated answer
          </span>
        ) : (
          <span className="badge" title="Genie wrote this SQL from the question; no matching trusted asset">
            Generated
          </span>
        )}
        <button className="linkish" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </header>
      {open && (
        <>
          {description && <p className="muted small">{description}</p>}
          <pre className="sql"><code>{sql}</code></pre>
        </>
      )}
    </section>
  )
}
