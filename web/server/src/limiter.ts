/**
 * Guardrails for a shared-identity proxy in front of a Free Edition workspace:
 *  - a global token bucket below Databricks' documented 5 questions/min API cap;
 *  - a queue of depth 1 so a burst gets "waiting" instead of an instant 429;
 *  - one in-flight question per browser session (no accidental double-submits).
 */
import { config } from "./config.js";

const refillMs = 60_000 / config.questionsPerMinute;
const capacity = config.questionsPerMinute;

let tokens = capacity;
let lastRefill = Date.now();
let waiting = 0;
const inFlight = new Set<string>();

function refill() {
  const now = Date.now();
  const gained = Math.floor((now - lastRefill) / refillMs);
  if (gained > 0) {
    tokens = Math.min(capacity, tokens + gained);
    lastRefill += gained * refillMs;
  }
}

export class RateLimited extends Error {
  constructor(public readonly retryAfterSec: number) {
    super(`Rate limited; retry after ${retryAfterSec}s`);
  }
}

export class SessionBusy extends Error {
  constructor() {
    super("This session already has a question in flight");
  }
}

/** Resolves when a slot is available. `onQueued` fires if the caller had to wait. */
export async function acquire(sessionId: string, onQueued: () => void): Promise<void> {
  if (inFlight.has(sessionId)) throw new SessionBusy();
  refill();
  if (tokens > 0) {
    tokens -= 1;
    inFlight.add(sessionId);
    return;
  }
  if (waiting >= 1) {
    throw new RateLimited(Math.ceil((refillMs - (Date.now() - lastRefill)) / 1000));
  }
  waiting += 1;
  onQueued();
  try {
    const deadline = Date.now() + refillMs + 500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      refill();
      if (tokens > 0) {
        tokens -= 1;
        inFlight.add(sessionId);
        return;
      }
    }
    throw new RateLimited(Math.ceil(refillMs / 1000));
  } finally {
    waiting -= 1;
  }
}

export function release(sessionId: string) {
  inFlight.delete(sessionId);
}

export function snapshot() {
  refill();
  return { tokens, capacity, waiting, inFlight: inFlight.size, questionsPerMinute: config.questionsPerMinute };
}
