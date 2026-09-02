import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useGenieChat,
  type GenieAttachmentResponse,
  type GenieMessageItem,
  type GenieStatementResponse,
} from '@databricks/appkit-ui/react'
import { StatusStepper } from './StatusStepper'

/**
 * Ported from web/client/src/components/{Chat,SqlPanel,ResultTable}.tsx to prove the SSE
 * contract the standalone site (web/) hand-rolled matches AppKit's own `genie()` plugin —
 * driven here by `useGenieChat` instead of a bespoke fetch + SSE parser. Two real gaps found
 * porting it, both called out inline below and in app/README.md:
 *
 *  1. No curated-answer signal. web/'s SqlPanel shows a "Curated answer" badge when the
 *     Conversation API attachment carries `instruction_id` (a matched trusted-asset query).
 *     AppKit's cleaned `GenieAttachmentResponse.query` type has no `instruction_id` field —
 *     so every query here reads as plain "Generated", even when Genie answered from a
 *     curated example. Confirmed by reading the shipped .d.ts, not by trial and error.
 *  2. No row count / truncation flag. `GenieStatementResponse` is a subset of the raw
 *     statement response — no `total_row_count` or `truncated`. The table below can only
 *     report "N rows shown", not "N of M total".
 */

const NUMERIC = new Set(['INT', 'LONG', 'SHORT', 'BYTE', 'FLOAT', 'DOUBLE', 'DECIMAL'])

function fmt(value: string | null, type: string): string {
  if (value === null || value === undefined) return '∅'
  if (NUMERIC.has(type)) {
    const n = Number(value)
    if (!Number.isNaN(n)) return n.toLocaleString(undefined, { maximumFractionDigits: 3 })
  }
  return value
}

function QueryResultTable({ data }: { data: GenieStatementResponse }) {
  const columns = data.manifest.schema.columns
  const rows = data.result.data_array.slice(0, 200)
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">The query ran but returned no rows.</p>
  }
  return (
    <div className="mt-2 max-h-[420px] overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.name} className={NUMERIC.has(c.type_name) ? 'text-right' : ''} title={c.type_name}>
                {c.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j} className={NUMERIC.has(columns[j]?.type_name ?? '') ? 'text-right tabular-nums' : ''}>
                  {fmt(cell, columns[j]?.type_name ?? '')}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.result.data_array.length > rows.length && (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">showing first {rows.length} rows</p>
      )}
    </div>
  )
}

function QueryBlock({ query, data }: { query: NonNullable<GenieAttachmentResponse['query']>; data?: GenieStatementResponse }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-2 rounded-md border p-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-center gap-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-auto p-0 font-medium">
              {open ? '▾' : '▸'} Generated SQL
            </Button>
          </CollapsibleTrigger>
          <Badge variant="outline" title="useGenieChat's attachment type has no instruction_id field to detect a curated match">
            Generated
          </Badge>
        </div>
        <CollapsibleContent>
          {query.description && <p className="mt-1 text-sm text-muted-foreground">{query.description}</p>}
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">
            <code>{query.query}</code>
          </pre>
        </CollapsibleContent>
      </Collapsible>
      {data ? <QueryResultTable data={data} /> : <Spinner className="mt-2 h-4 w-4" />}
    </div>
  )
}

function MessageView({ message, onAsk }: { message: GenieMessageItem; onAsk: (q: string) => void }) {
  const done = message.status === 'COMPLETED' || message.status === 'FAILED'
  const texts = message.attachments.filter((a) => a.text).map((a) => a.text!.content)
  const queries = message.attachments.filter((a) => a.query)
  const followUps = message.attachments.flatMap((a) => a.suggestedQuestions ?? [])

  if (message.role === 'user') {
    return <div className="ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{message.content}</div>
  }

  return (
    <div className="max-w-[90%] space-y-2">
      {!done && <StatusStepper status={message.status} />}
      {message.error && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {message.error}
        </div>
      )}
      {texts.map((t, i) => (
        <p key={i} className="whitespace-pre-wrap text-sm">{t}</p>
      ))}
      {queries.map((a, i) => (
        <QueryBlock key={a.attachmentId ?? i} query={a.query!} data={a.attachmentId ? message.queryResults.get(a.attachmentId) : undefined} />
      ))}
      {done && !message.error && (
        <p className="text-xs text-muted-foreground">AI-generated from the SQL above; verify before relying on it.</p>
      )}
      {followUps.length > 0 && done && (
        <div className="flex flex-wrap gap-2 pt-1">
          {followUps.map((q) => (
            <Button key={q} variant="outline" size="sm" className="h-auto whitespace-normal py-1.5 text-left" onClick={() => onAsk(q)}>
              {q}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

export function CustomGenieChat() {
  const { messages, status, sendMessage, reset } = useGenieChat({ alias: 'default' })
  const [draft, setDraft] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  const busy = status === 'streaming' || status === 'loading-history'

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const ask = (q: string) => {
    if (!q.trim() || busy) return
    sendMessage(q.trim())
    setDraft('')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    ask(draft)
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Same Genie space, driven by <code className="font-mono">useGenieChat</code> instead of{' '}
        <code className="font-mono">&lt;GenieChat/&gt;</code> — a from-scratch UI on AppKit&apos;s hook, the same relationship
        web/&apos;s hand-rolled client has to its own SSE proxy.
      </p>
      <div className="flex-1 space-y-4 overflow-y-auto">
        {messages.map((m) => (
          <MessageView key={m.id} message={m} onAsk={ask} />
        ))}
        <div ref={bottom} />
      </div>
      <form onSubmit={submit} className="flex flex-col gap-2 border-t pt-3">
        <Textarea
          value={draft}
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
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={busy}>
              New conversation
            </Button>
          )}
          <Button type="submit" size="sm" className="ml-auto" disabled={busy || !draft.trim()}>
            {busy ? 'Working…' : 'Ask'}
          </Button>
        </div>
      </form>
    </div>
  )
}
