/**
 * Thin typed wrapper over the Genie Conversation API (chat mode, GA).
 * Every call is scoped to one space and authenticated with one bearer token,
 * so every visitor to the site runs as that single identity.
 */
import { config } from "./config.js";

export type MessageStatus =
  | "SUBMITTED"
  | "FILTERING_CONTEXT"
  | "ASKING_AI"
  | "PENDING_WAREHOUSE"
  | "EXECUTING_QUERY"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "QUERY_RESULT_EXPIRED";

export interface QueryAttachment {
  query?: string;
  description?: string;
  title?: string;
  /** Present when Genie answered from a trusted asset (example SQL / UC function). */
  instruction_id?: string;
  instruction_title?: string;
  statement_id?: string;
  query_result_metadata?: { row_count?: number; is_truncated?: boolean };
}

export interface Attachment {
  attachment_id: string;
  query?: QueryAttachment;
  text?: { content: string };
  suggested_questions?: { questions?: string[] };
}

export interface GenieMessage {
  id: string;
  conversation_id: string;
  space_id?: string;
  status: MessageStatus;
  content: string;
  created_timestamp?: number;
  error?: { error?: string; type?: string };
  attachments?: Attachment[];
}

export interface StatementColumn {
  name: string;
  type_name: string;
}

export interface QueryResult {
  statement_response?: {
    status?: { state?: string; error?: { message?: string } };
    manifest?: {
      schema?: { columns?: StatementColumn[] };
      total_row_count?: number;
      truncated?: boolean;
    };
    result?: { data_array?: string[][]; row_count?: number };
  };
}

export interface Conversation {
  id: string;
  title?: string;
  created_timestamp?: number;
  last_updated_timestamp?: number;
}

export class GenieHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Genie API ${status} on ${path}: ${body.slice(0, 300)}`);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.host}/api/2.0/genie/spaces/${config.spaceId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "User-Agent": "openelec-genie-web/0.1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GenieHttpError(res.status, path, text);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const genie = {
  getSpace: () => call<{ space_id: string; title: string; description?: string }>("GET", ""),

  startConversation: (content: string) =>
    call<{ conversation_id: string; message_id: string; message?: GenieMessage }>(
      "POST",
      "/start-conversation",
      { content },
    ),

  createMessage: (conversationId: string, content: string) =>
    call<GenieMessage>("POST", `/conversations/${conversationId}/messages`, { content }),

  getMessage: (conversationId: string, messageId: string) =>
    call<GenieMessage>("GET", `/conversations/${conversationId}/messages/${messageId}`),

  listMessages: (conversationId: string) =>
    call<{ messages?: GenieMessage[] }>("GET", `/conversations/${conversationId}/messages`),

  getQueryResult: (conversationId: string, messageId: string, attachmentId: string) =>
    call<QueryResult>(
      "GET",
      `/conversations/${conversationId}/messages/${messageId}/attachments/${attachmentId}/query-result`,
    ),

  executeQuery: (conversationId: string, messageId: string, attachmentId: string) =>
    call<QueryResult>(
      "POST",
      `/conversations/${conversationId}/messages/${messageId}/attachments/${attachmentId}/execute-query`,
    ),

  listConversations: (pageToken?: string) =>
    call<{ conversations?: Conversation[]; next_page_token?: string }>(
      "GET",
      `/conversations${pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : ""}`,
    ),

  deleteConversation: (conversationId: string) =>
    call<Record<string, never>>("DELETE", `/conversations/${conversationId}`),
};

export const TERMINAL: ReadonlySet<MessageStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "QUERY_RESULT_EXPIRED",
]);

/**
 * Agent mode (Preview). The request shape (`input` as an array of `{type:"message",
 * role:"user", content:[{type:"input_text", text}]}` items, mirroring the OpenAI Responses API)
 * was originally reverse-engineered by trial against this workspace on 2026-09-02, since
 * confirmed documented: https://docs.databricks.com/aws/en/genie-agents/api. Confirmed live and
 * NOT admin-gated on this workspace. The docs also confirm conversation continuation: an
 * optional top-level `conversation_id` continues a prior agent-mode conversation; omit it to
 * start a new one.
 */
export interface AgentContentMetadata {
  message_id?: string;
  statement_id?: string;
  sql?: string;
  columns?: StatementColumn[];
  preview_rows?: string[][];
  total_row_count?: number;
  status?: string;
}

export interface AgentResponseItem {
  type: string;
  id?: string;
  status?: string;
  content?: { type: string; text?: string; metadata?: AgentContentMetadata }[];
  name?: string;
  arguments?: string;
  output?: string;
  role?: string;
  metadata?: AgentContentMetadata;
}

export interface AgentStreamEvent {
  type: string;
  response?: { id: string; conversation_id: string; status?: string };
  item?: AgentResponseItem;
}

/**
 * Raw, unparsed fetch to the Agent mode responses endpoint (note: /genie/agents/, not
 * /genie/spaces/ — a different path prefix from the rest of this file). Returns the live
 * Response so the caller can stream its SSE body through rather than buffering it.
 */
export async function streamAgentResponse(content: string, conversationId?: string): Promise<Response> {
  const url = `${config.host}/api/2.0/genie/agents/${config.spaceId}/responses`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": "openelec-genie-web/0.1",
    },
    body: JSON.stringify({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: content }] }],
      ...(conversationId ? { conversation_id: conversationId } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new GenieHttpError(res.status, "/responses", text);
  }
  return res;
}
