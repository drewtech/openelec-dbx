/**
 * Minimal, safe renderer for the little markdown Genie agent-mode messages actually use:
 * `#`-`######` headings (all rendered at one size — this is a chat bubble, not a document),
 * `**bold**` spans, and citation links. Not a general markdown parser — no lists or tables
 * (tables arrive as structured metadata and render via ResultTable instead).
 *
 * Citations arrive as `\[[1] (https://...)\]` — an escaped-bracket footnote wrapping a
 * bracketed number and a parenthesized URL, not a standard markdown link — so they need their
 * own pattern alongside `**bold**` rather than falling out of a plain link parser.
 */
const HEADING = /^#{1,6}\s+/
const INLINE = /\*\*(.+?)\*\*|\\\[\[(\d+)\]\s*\((https?:\/\/[^\s)]+)\)\\\]/g

function renderInline(line: string, keyPrefix: string) {
  const nodes = []
  let last = 0
  let i = 0
  for (const m of line.matchAll(INLINE)) {
    if (m.index > last) nodes.push(line.slice(last, m.index))
    if (m[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{m[1]}</strong>)
    } else {
      nodes.push(
        <a key={`${keyPrefix}-${i++}`} className="citation" href={m[3]} target="_blank" rel="noreferrer">
          [{m[2]}]
        </a>,
      )
    }
    last = m.index + m[0].length
  }
  if (last < line.length) nodes.push(line.slice(last))
  return nodes
}

export function Markdownish({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, i) => {
        if (!line.trim()) return null
        const heading = line.match(HEADING)
        if (heading) return <h3 key={i}>{renderInline(line.slice(heading[0].length), `h${i}`)}</h3>
        return <p key={i} className="pre">{renderInline(line, `p${i}`)}</p>
      })}
    </>
  )
}
