import type { QueryResultPayload } from '../api'

const NUMERIC = new Set(['INT', 'LONG', 'SHORT', 'BYTE', 'FLOAT', 'DOUBLE', 'DECIMAL'])

function fmt(value: string | null, type: string): string {
  if (value === null || value === undefined) return '∅'
  if (NUMERIC.has(type)) {
    const n = Number(value)
    if (!Number.isNaN(n)) return n.toLocaleString(undefined, { maximumFractionDigits: 3 })
  }
  return value
}

export function ResultTable({ result }: { result: QueryResultPayload }) {
  const shown = result.rows.slice(0, 200)
  const total = result.totalRowCount ?? result.rows.length
  const copyCsv = async () => {
    const esc = (v: string | null) => (v === null ? '' : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    const csv = [result.columns.map((c) => esc(c.name)).join(','), ...result.rows.map((r) => r.map(esc).join(','))].join('\n')
    try {
      await navigator.clipboard.writeText(csv)
    } catch {
      /* clipboard blocked */
    }
  }
  if (result.rows.length === 0) {
    return (
      <section className="panel">
        <header className="panel-head"><strong>Result</strong></header>
        <p className="muted">The query ran but returned no rows. Check the filters in the SQL above.</p>
      </section>
    )
  }
  return (
    <section className="panel">
      <header className="panel-head">
        <strong>Result</strong>
        <span className="muted small">
          {total.toLocaleString()} row{total === 1 ? '' : 's'}
          {shown.length < result.rows.length ? `, showing first ${shown.length}` : ''}
          {result.truncated ? ' (server truncated)' : ''}
        </span>
        <button className="linkish" onClick={copyCsv}>Copy CSV</button>
      </header>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{result.columns.map((c) => <th key={c.name} className={NUMERIC.has(c.type) ? 'num' : ''} title={c.type}>{c.name}</th>)}</tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className={NUMERIC.has(result.columns[j]?.type ?? '') ? 'num' : ''}>{fmt(cell, result.columns[j]?.type ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
