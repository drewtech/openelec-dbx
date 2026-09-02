/**
 * Housekeeping for the 10,000-conversation cap per space. Dry-run by default.
 *   npm run prune                # list conversations older than 24 h
 *   npm run prune -- --yes       # delete them
 *   npm run prune -- --hours 6   # different age threshold
 */
import { genie, type Conversation } from "./genie.js";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const hoursIdx = args.indexOf("--hours");
const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : 24;
const cutoff = Date.now() - hours * 3600_000;

const all: Conversation[] = [];
let token: string | undefined;
do {
  const page = await genie.listConversations(token);
  all.push(...(page.conversations ?? []));
  token = page.next_page_token;
} while (token);

const stale = all.filter((c) => (c.last_updated_timestamp ?? c.created_timestamp ?? 0) < cutoff);
console.log(`${all.length} conversations visible, ${stale.length} older than ${hours}h`);
for (const c of stale) {
  const when = new Date(c.last_updated_timestamp ?? c.created_timestamp ?? 0).toISOString();
  if (yes) {
    await genie.deleteConversation(c.id);
    console.log(`deleted ${c.id} (${when}) ${c.title ?? ""}`);
  } else {
    console.log(`would delete ${c.id} (${when}) ${c.title ?? ""}`);
  }
}
if (!yes && stale.length) console.log("Re-run with --yes to delete.");
