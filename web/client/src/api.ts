export interface SpaceInfo {
  spaceId: string
  title: string
  description: string
  sampleQuestions: string[]
  tables: string[]
  identity: { mode: 'shared-token'; note: string }
  limits: { questionsPerMinute: number; maxQuestionChars: number }
  embedUrl: string
  appUrl?: string
}

export interface QueryResultPayload {
  attachmentId: string
  columns: { name: string; type: string }[]
  rows: string[][]
  totalRowCount?: number
  truncated: boolean
}

export interface NormalizedAttachment {
  id: string
  kind: 'query' | 'text' | 'suggested_questions'
  text?: string
  query?: { sql: string; description?: string; curated: boolean; curatedTitle?: string }
  questions?: string[]
}

export type GenieEvent =
  | { event: 'message_start'; data: { conversationId: string; messageId: string; spaceId: string } }
  | { event: 'status'; data: { status: string } }
  | { event: 'query_result'; data: QueryResultPayload }
  | { event: 'message_result'; data: { content: string; attachments: NormalizedAttachment[] } }
  | { event: 'error'; data: { error: string; type?: string } }

export interface AgentMessagePart {
  text: string
  tableCaption?: string
  table?: { columns: { name: string; type: string }[]; rows: string[][]; totalRowCount?: number; truncated: boolean }
}

export interface AgentItem {
  id: string
  kind: 'reasoning' | 'sql_call' | 'message'
  reasoningText?: string
  sqlCall?: { title?: string; sql: string }
  messageParts?: AgentMessagePart[]
}

export type AgentEvent =
  | { event: 'status'; data: { status: string } }
  | { event: 'agent_start'; data: { conversationId: string; responseId: string } }
  | { event: 'agent_item'; data: AgentItem }
  | { event: 'agent_done'; data: { conversationId: string } }
  | { event: 'error'; data: { error: string; type?: string } }

export async function getSpace(): Promise<SpaceInfo> {
  const res = await fetch('/api/genie/space')
  if (!res.ok) throw new Error(`space info ${res.status}`)
  return res.json()
}

export function sessionId(): string {
  const key = 'openelec-genie:session'
  try {
    let id = localStorage.getItem(key)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(key, id)
    }
    return id
  } catch {
    return 'anon'
  }
}

/**
 * Consume a text/event-stream response body (EventSource is GET-only, so this parses
 * event: / data: lines by hand, blank-line delimited) and hand each frame to `onEvent`.
 */
async function consumeSse<E extends { event: string; data: unknown }>(
  res: Response,
  onEvent: (evt: E) => void,
): Promise<void> {
  if (!res.ok || !res.body) {
    let detail = `${res.status}`
    try {
      detail = (await res.json()).error ?? detail
    } catch {
      /* non-JSON error body */
    }
    onEvent({ event: 'error', data: { error: detail, type: 'HTTP' } } as E)
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length) {
        onEvent({ event, data: JSON.parse(dataLines.join('\n')) } as E)
      }
    }
  }
}

/** Chat mode: continues `conversationId` if given, otherwise starts a new conversation. */
export async function streamMessage(
  content: string,
  conversationId: string | undefined,
  onEvent: (evt: GenieEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/genie/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId() },
    body: JSON.stringify({ content, conversationId }),
    signal,
  })
  return consumeSse(res, onEvent)
}

/** Agent mode (Preview): continues `conversationId` if given, otherwise starts a new agent conversation. */
export async function streamAgentResponse(
  content: string,
  conversationId: string | undefined,
  onEvent: (evt: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/genie/agent-responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId() },
    body: JSON.stringify({ content, conversationId }),
    signal,
  })
  return consumeSse(res, onEvent)
}
