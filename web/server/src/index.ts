import cors from "cors";
import express, { type Request, type Response } from "express";
import { Readable } from "node:stream";
import { config } from "./config.js";
import {
  GenieHttpError,
  TERMINAL,
  genie,
  streamAgentResponse,
  type Attachment,
  type AgentResponseItem,
  type AgentStreamEvent,
  type GenieMessage,
} from "./genie.js";
import { RateLimited, SessionBusy, acquire, release, snapshot } from "./limiter.js";
import { getSpaceInfo } from "./space.js";

const app = express();
app.use(cors({ origin: config.allowedOrigins }));
app.use(express.json({ limit: "16kb" }));

/** Event names deliberately mirror AppKit's genie() plugin so the client ports to a Databricks App unchanged. */
type SseEvent =
  | { event: "message_start"; data: { conversationId: string; messageId: string; spaceId: string } }
  | { event: "status"; data: { status: string } }
  | { event: "query_result"; data: QueryResultPayload }
  | { event: "message_result"; data: { content: string; attachments: NormalizedAttachment[] } }
  | { event: "agent_start"; data: { conversationId: string; responseId: string } }
  | { event: "agent_item"; data: AgentItem }
  | { event: "agent_done"; data: { conversationId: string } }
  | { event: "error"; data: { error: string; type?: string } };

interface QueryResultPayload {
  attachmentId: string;
  columns: { name: string; type: string }[];
  rows: string[][];
  totalRowCount?: number;
  truncated: boolean;
}

interface NormalizedAttachment {
  id: string;
  kind: "query" | "text" | "suggested_questions";
  text?: string;
  query?: { sql: string; description?: string; curated: boolean; curatedTitle?: string };
  questions?: string[];
}

interface AgentItem {
  id: string;
  kind: "reasoning" | "sql_call" | "message";
  reasoningText?: string;
  sqlCall?: { title?: string; sql: string };
  messageParts?: {
    text: string;
    tableCaption?: string;
    table?: { columns: { name: string; type: string }[]; rows: string[][]; totalRowCount?: number; truncated: boolean };
  }[];
}

/**
 * Agent mode's column metadata carries `name` only, no `type_name` (confirmed empirically:
 * chat mode's statement API always includes it, this doesn't). Infer numeric vs string from
 * the first row's actual value so ResultTable can still right-align and format numbers.
 */
function inferColumnType(sample: string | undefined): string {
  return sample !== undefined && sample !== null && sample !== "" && !Number.isNaN(Number(sample)) ? "DOUBLE" : "STRING";
}

/** First line of a `**Title**`-style markdown caption Genie prepends to a table part. */
function stripBoldCaption(text: string): string | undefined {
  const first = text.split("\n")[0]?.trim();
  if (first?.startsWith("**") && first.endsWith("**") && first.length > 4) return first.slice(2, -2);
  return undefined;
}

/** Only called on `response.output_item.done` — `.added` events carry incomplete content. */
function normalizeAgentItem(item: AgentResponseItem): AgentItem | undefined {
  if (item.type === "reasoning") {
    const text = (item.content ?? []).map((c) => c.text).filter(Boolean).join(" ");
    if (!text) return undefined;
    return { id: item.id ?? crypto.randomUUID(), kind: "reasoning", reasoningText: text };
  }
  if (item.type === "function_call") {
    try {
      const args = JSON.parse(item.arguments ?? "{}") as { title?: string; sql?: string };
      if (!args.sql) return undefined;
      return { id: item.id ?? crypto.randomUUID(), kind: "sql_call", sqlCall: { title: args.title, sql: args.sql } };
    } catch {
      return undefined;
    }
  }
  if (item.type === "message" && item.role === "assistant") {
    const parts = (item.content ?? []).map((part) => {
      const text = part.text ?? "";
      const meta = part.metadata;
      if (meta?.columns && meta.preview_rows) {
        return {
          text: "",
          tableCaption: stripBoldCaption(text),
          table: {
            columns: meta.columns.map((c, i) => ({ name: c.name, type: c.type_name ?? inferColumnType(meta.preview_rows?.[0]?.[i]) })),
            rows: meta.preview_rows,
            totalRowCount: meta.total_row_count,
            truncated: Boolean(meta.total_row_count && meta.total_row_count > meta.preview_rows.length),
          },
        };
      }
      return { text };
    });
    return { id: item.id ?? crypto.randomUUID(), kind: "message", messageParts: parts };
  }
  // function_call_output and anything unrecognised: the same SQL + result surface again via the
  // final assistant message's structured metadata, so skip re-rendering it here.
  return undefined;
}

function normalize(attachments: Attachment[] | undefined): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  for (const a of attachments ?? []) {
    if (a.query) {
      out.push({
        id: a.attachment_id,
        kind: "query",
        query: {
          sql: a.query.query ?? "",
          description: a.query.description,
          curated: Boolean(a.query.instruction_id),
          curatedTitle: a.query.instruction_title,
        },
      });
    } else if (a.text) {
      out.push({ id: a.attachment_id, kind: "text", text: a.text.content });
    } else if (a.suggested_questions) {
      out.push({ id: a.attachment_id, kind: "suggested_questions", questions: a.suggested_questions.questions ?? [] });
    }
  }
  return out;
}

function sse(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  return {
    send(evt: SseEvent) {
      res.write(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    },
    /** SSE comment line: keeps idle proxies from closing the stream while Genie thinks. */
    ping() {
      res.write(": ping\n\n");
    },
    end() {
      res.end();
    },
  };
}

async function fetchQueryResult(
  conversationId: string,
  messageId: string,
  attachmentId: string,
): Promise<QueryResultPayload> {
  let result = await genie.getQueryResult(conversationId, messageId, attachmentId);
  const state = result.statement_response?.status?.state;
  // Results expire; re-execute once rather than surfacing a stale-cache error.
  if (!result.statement_response?.result && (state === "CLOSED" || state === undefined)) {
    result = await genie.executeQuery(conversationId, messageId, attachmentId);
  }
  const sr = result.statement_response;
  if (sr?.status?.state && sr.status.state !== "SUCCEEDED") {
    throw new Error(`Query ${sr.status.state}: ${sr.status.error?.message ?? "no detail"}`);
  }
  const rows = sr?.result?.data_array ?? [];
  const total = sr?.manifest?.total_row_count;
  return {
    attachmentId,
    columns: (sr?.manifest?.schema?.columns ?? []).map((c) => ({ name: c.name, type: c.type_name })),
    rows,
    totalRowCount: total,
    truncated: Boolean(sr?.manifest?.truncated) || (total !== undefined && total > rows.length),
  };
}

app.get("/healthz", async (_req, res) => {
  try {
    const info = await getSpaceInfo();
    res.json({ ok: true, space: info.title, spaceId: info.spaceId, limiter: snapshot() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get("/api/genie/space", async (_req, res) => {
  res.json(await getSpaceInfo());
});

app.get("/api/genie/conversations/:id", async (req, res) => {
  try {
    const { messages = [] } = await genie.listMessages(req.params.id);
    res.json({
      messages: messages.map((m) => ({
        id: m.id,
        status: m.status,
        content: m.content,
        attachments: normalize(m.attachments),
        error: m.error,
      })),
    });
  } catch (err) {
    const status = err instanceof GenieHttpError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

app.post("/api/genie/messages", async (req: Request, res: Response) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : undefined;
  const sessionId = (req.header("x-session-id") ?? req.ip ?? "anon").slice(0, 64);

  if (!content) return res.status(400).json({ error: "content is required" });
  if (content.length > config.maxQuestionChars) {
    return res.status(413).json({ error: `Question longer than ${config.maxQuestionChars} characters` });
  }

  const stream = sse(res);
  // res "close" fires when the socket goes away; req "close" fires as soon as the body is
  // consumed in modern Node, which would cancel every poll loop immediately.
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  try {
    await acquire(sessionId, () => stream.send({ event: "status", data: { status: "QUEUED" } }));
  } catch (err) {
    if (err instanceof RateLimited) {
      stream.send({ event: "error", data: { error: `Rate limited: try again in ${err.retryAfterSec}s`, type: "RATE_LIMITED" } });
    } else if (err instanceof SessionBusy) {
      stream.send({ event: "error", data: { error: err.message, type: "SESSION_BUSY" } });
    } else {
      stream.send({ event: "error", data: { error: (err as Error).message } });
    }
    return stream.end();
  }

  try {
    let convId = conversationId;
    let msgId: string;
    if (convId) {
      const created = await genie.createMessage(convId, content);
      msgId = created.id;
    } else {
      const started = await genie.startConversation(content);
      convId = started.conversation_id;
      msgId = started.message_id;
    }
    stream.send({ event: "message_start", data: { conversationId: convId, messageId: msgId, spaceId: config.spaceId } });

    let last: string | undefined;
    let message: GenieMessage | undefined;
    const deadline = Date.now() + config.pollTimeoutMs;
    while (!closed && Date.now() < deadline) {
      message = await genie.getMessage(convId, msgId);
      if (message.status !== last) {
        last = message.status;
        stream.send({ event: "status", data: { status: message.status } });
      }
      if (TERMINAL.has(message.status)) break;
      stream.ping();
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    }
    if (closed) return;
    if (!message || !TERMINAL.has(message.status)) {
      stream.send({ event: "error", data: { error: "Timed out waiting for Genie", type: "TIMEOUT" } });
      return stream.end();
    }
    if (message.status === "FAILED" || message.status === "CANCELLED") {
      stream.send({
        event: "error",
        data: { error: message.error?.error ?? `Message ${message.status}`, type: message.error?.type ?? message.status },
      });
      return stream.end();
    }

    const attachments = normalize(message.attachments);
    for (const a of attachments) {
      if (a.kind !== "query") continue;
      try {
        stream.send({ event: "query_result", data: await fetchQueryResult(convId, msgId, a.id) });
      } catch (err) {
        stream.send({ event: "error", data: { error: `Result fetch failed: ${(err as Error).message}`, type: "RESULT_FETCH" } });
      }
    }
    stream.send({ event: "message_result", data: { content: message.content, attachments } });
    stream.end();
  } catch (err) {
    const detail = err instanceof GenieHttpError ? `${err.status} from Databricks: ${err.body.slice(0, 200)}` : (err as Error).message;
    console.error(detail);
    stream.send({ event: "error", data: { error: detail, type: "UPSTREAM" } });
    stream.end();
  } finally {
    release(sessionId);
  }
});

/**
 * Agent mode (Preview): continues `conversationId` if given, otherwise starts a new agent
 * conversation, same shape as /api/genie/messages. Relays Databricks' own SSE stream,
 * normalizing item shapes into `agent_*` events (see genie.ts's streamAgentResponse).
 */
app.post("/api/genie/agent-responses", async (req: Request, res: Response) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : undefined;
  const sessionId = (req.header("x-session-id") ?? req.ip ?? "anon").slice(0, 64);

  if (!content) return res.status(400).json({ error: "content is required" });
  if (content.length > config.maxQuestionChars) {
    return res.status(413).json({ error: `Question longer than ${config.maxQuestionChars} characters` });
  }

  const stream = sse(res);
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  try {
    await acquire(sessionId, () => stream.send({ event: "status", data: { status: "QUEUED" } }));
  } catch (err) {
    if (err instanceof RateLimited) {
      stream.send({ event: "error", data: { error: `Rate limited: try again in ${err.retryAfterSec}s`, type: "RATE_LIMITED" } });
    } else if (err instanceof SessionBusy) {
      stream.send({ event: "error", data: { error: err.message, type: "SESSION_BUSY" } });
    } else {
      stream.send({ event: "error", data: { error: (err as Error).message } });
    }
    return stream.end();
  }

  try {
    const upstream = await streamAgentResponse(content, conversationId);
    const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      if (closed) break;
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        let evt: AgentStreamEvent;
        try {
          evt = JSON.parse(dataLine.slice(5).trim()) as AgentStreamEvent;
        } catch {
          continue;
        }
        if (evt.type === "response.created" && evt.response) {
          stream.send({ event: "agent_start", data: { conversationId: evt.response.conversation_id, responseId: evt.response.id } });
        } else if (evt.type === "response.output_item.done" && evt.item) {
          const item = normalizeAgentItem(evt.item);
          if (item) stream.send({ event: "agent_item", data: item });
        } else if (evt.type === "response.completed" && evt.response) {
          stream.send({ event: "agent_done", data: { conversationId: evt.response.conversation_id } });
        } else if (evt.type === "response.failed") {
          stream.send({ event: "error", data: { error: "Agent response failed", type: "AGENT_FAILED" } });
        }
      }
    }
    stream.end();
  } catch (err) {
    const detail = err instanceof GenieHttpError ? `${err.status} from Databricks: ${err.body.slice(0, 200)}` : (err as Error).message;
    console.error(detail);
    stream.send({ event: "error", data: { error: detail, type: "UPSTREAM" } });
    stream.end();
  } finally {
    release(sessionId);
  }
});

app.listen(config.port, () => {
  console.log(`genie proxy listening on http://localhost:${config.port} (space ${config.spaceId}, ${config.questionsPerMinute} q/min)`);
  getSpaceInfo().catch(() => undefined);
});
