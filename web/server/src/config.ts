function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. See server/.env.example.`);
  }
  return value;
}

export const config = {
  host: required("DATABRICKS_HOST").replace(/\/+$/, ""),
  token: required("DATABRICKS_TOKEN"),
  /** No fallback on purpose — every workspace has a different space id. See server/.env.example. */
  spaceId: required("GENIE_SPACE_ID"),
  /** The deployed Databricks App's public URL (Phase 7 Step 1), if any. See app/README.md. */
  appUrl: process.env.APP_URL,
  /** Workspace id, used to build the Genie room URL for the embed demo. Optional — the room
   *  URL works without it; `?w=` just matches what Databricks' own UI appends. */
  workspaceId: process.env.DATABRICKS_WORKSPACE_ID,
  port: Number(process.env.PORT ?? 3000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  questionsPerMinute: Number(process.env.QUESTIONS_PER_MINUTE ?? 4),
  /** Docs: poll every 1–5 s, give up after ~10 min. */
  pollIntervalMs: 2000,
  pollTimeoutMs: 10 * 60 * 1000,
  maxQuestionChars: 500,
};
