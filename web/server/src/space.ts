/**
 * Space metadata served to the client. Sample questions and table list come from the
 * committed space definition (resources/openelec.geniespace.json) so the empty state works
 * even before the first API call; title/description come from the live space when reachable.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { genie } from "./genie.js";

interface SpaceJson {
  config?: { sample_questions?: { question: string[] }[] };
  data_sources?: { tables?: { identifier: string }[] };
}

const specPath = resolve(import.meta.dirname, "../../../resources/openelec.geniespace.json");

function loadSpec(): SpaceJson {
  try {
    return JSON.parse(readFileSync(specPath, "utf8")) as SpaceJson;
  } catch (err) {
    console.warn(`Could not read ${specPath}: ${(err as Error).message}`);
    return {};
  }
}

export interface SpaceInfo {
  spaceId: string;
  title: string;
  description: string;
  sampleQuestions: string[];
  tables: string[];
  /** Truthful execution-identity note: everything runs as the proxy's token owner. */
  identity: { mode: "shared-token"; note: string };
  limits: { questionsPerMinute: number; maxQuestionChars: number };
  /**
   * The space's own room URL — the same link "Genie space → Share → Embed space" wraps in an
   * iframe. Requires `localhost:5173` (or the demo's real domain) on the workspace's AI/BI
   * embedding approved-domains list; see web/README.md's Embed section for how that was set.
   */
  embedUrl: string;
  /** Deployed Databricks App URL (Phase 7 Step 1), or undefined if not deployed/configured. */
  appUrl?: string;
}

let cached: SpaceInfo | undefined;

export async function getSpaceInfo(): Promise<SpaceInfo> {
  if (cached) return cached;
  const spec = loadSpec();
  let title = "OpenElectricity NEM";
  let description = "Natural-language Q&A over NEM generation, emissions and capacity marts.";
  try {
    const live = await genie.getSpace();
    title = live.title || title;
    description = live.description || description;
  } catch (err) {
    console.warn(`get-space failed, using static title: ${(err as Error).message}`);
  }
  cached = {
    spaceId: config.spaceId,
    title,
    description,
    sampleQuestions: (spec.config?.sample_questions ?? []).map((q) => q.question[0]).filter(Boolean),
    tables: (spec.data_sources?.tables ?? []).map((t) => t.identifier),
    identity: {
      mode: "shared-token",
      note: "Every question on this site runs on Databricks as one shared identity (the demo's personal access token). There is no per-visitor permission or audit trail.",
    },
    limits: { questionsPerMinute: config.questionsPerMinute, maxQuestionChars: config.maxQuestionChars },
    embedUrl: `${config.host}/genie/rooms/${config.spaceId}${config.workspaceId ? `?w=${config.workspaceId}` : ""}`,
    appUrl: config.appUrl,
  };
  return cached;
}
