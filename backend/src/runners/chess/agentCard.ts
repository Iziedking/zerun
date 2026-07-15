import { query } from "../../db/pool.js";
import { config } from "../../config/index.js";
import { chessAgentCardUri } from "../../identity/erc8004.js";
import { currentChessSeason } from "./ratings.js";

// The ERC-8004 agent card (the registration JSON an agentURI resolves to). Served live from the DB so
// it stays current across re-uploads: the URI on-chain never changes, but the provenance it points to
// always reflects the agent's latest code. This is the surface any ERC-8004 explorer, marketplace, or
// other agent reads to discover a Zerun agent, and it carries the 0G provenance (the exact code's 0G
// Storage root) that makes "it competed on Zerun, thinking on 0G" verifiable off-platform.

export interface ChessAgentCard {
  name: string;
  description: string;
  url: string;
  image: string | null;
  provider: { name: string; url: string };
  // ERC-8004 discovery: where this identity is registered on-chain.
  registrations: { agentId: number | null; agentRegistry: string; chainId: number }[];
  // The trust surfaces this agent participates in (built out over the later phases).
  trustModels: string[];
  // Zerun-specific provenance. Namespaced so it never clashes with standard card fields.
  zerun: {
    kind: "chess";
    season: string;
    owner: string | null;
    codeSha: string | null;
    storageRoot: string | null; // 0G Storage root of the exact submitted bytes
    profile: string; // human-facing page
    endpoint: string; // this card's own URL
    createdAt: string | null;
    updatedAt: string | null;
  };
}

interface Row {
  id: string;
  owner: string | null;
  name: string;
  status: string;
  code_sha: string | null;
  storage_root: string | null;
  identity_token_id: string | null;
  created_at: string;
  updated_at: string;
}

// Build the card for one uploaded agent, or null if there is no such upload. Only 'upload' agents are
// exposed: house engine stand-ins are not identities anyone owns.
export async function chessAgentCard(agentDbId: number): Promise<ChessAgentCard | null> {
  const { rows } = await query<Row>(
    `select id, owner, name, status, code_sha, storage_root, identity_token_id,
            created_at::text as created_at, updated_at::text as updated_at
       from chess_agents
      where id = $1 and kind = 'upload'
      limit 1`,
    [agentDbId],
  );
  const r = rows[0];
  if (!r) return null;

  const tokenId = r.identity_token_id === null ? null : Number(r.identity_token_id);
  return {
    name: r.name,
    description:
      `${r.name} is a community chess agent competing in Zero Cup Chess on Zerun, the 0G agent arena. ` +
      `It reasons on the 0G Compute Network and its exact code is anchored on 0G Storage.`,
    url: "https://zerun.site/chess",
    image: null,
    provider: { name: "Zerun", url: "https://zerun.site" },
    registrations: [
      { agentId: tokenId, agentRegistry: config.identity.registry, chainId: config.identity.chainId },
    ],
    trustModels: ["reputation", "inference-validation"],
    zerun: {
      kind: "chess",
      season: currentChessSeason(),
      owner: r.owner,
      codeSha: r.code_sha,
      storageRoot: r.storage_root,
      profile: "https://zerun.site/chess",
      endpoint: chessAgentCardUri(Number(r.id)),
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    },
  };
}
