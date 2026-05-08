// Composio integration — TEMPORARILY STUBBED.
//
// We attempted to wire @composio/core but the package version pinning was
// unstable. The connector layer falls back to "no integrations connected"
// until we revisit. The chat + builtin tools (web_search, generate_artifact,
// browser_navigate, computer_use) keep working. Restore this when we lock
// to a verified Composio SDK version.

export interface ToolkitInfo {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  authSchemes: string[];
  noAuth: boolean;
}

export async function listToolkits(): Promise<ToolkitInfo[]> {
  // Static placeholder list — pure UI catalog with no actual Composio backend.
  // When Composio is restored, replace with `composio.toolkits.list()`.
  return [
    { slug: "slack", name: "Slack", description: "Send messages to channels and DMs.", logo: null, categories: ["Communication"], authSchemes: ["oauth2"], noAuth: false },
    { slug: "gmail", name: "Gmail", description: "Search inbox, draft replies, send email.", logo: null, categories: ["Communication"], authSchemes: ["oauth2"], noAuth: false },
    { slug: "linear", name: "Linear", description: "Read issues, search cycles, create tasks.", logo: null, categories: ["Productivity"], authSchemes: ["api_key"], noAuth: false },
    { slug: "notion", name: "Notion", description: "Read pages, append blocks, search database rows.", logo: null, categories: ["Productivity"], authSchemes: ["oauth2"], noAuth: false },
    { slug: "github", name: "GitHub", description: "Search repos, read issues, create PRs.", logo: null, categories: ["Developer"], authSchemes: ["oauth2"], noAuth: false },
    { slug: "stripe", name: "Stripe", description: "Read charges, customers, subscriptions.", logo: null, categories: ["Finance"], authSchemes: ["api_key"], noAuth: false },
    { slug: "airtable", name: "Airtable", description: "Read and write Airtable bases.", logo: null, categories: ["Productivity"], authSchemes: ["api_key"], noAuth: false },
    { slug: "hubspot", name: "HubSpot", description: "CRM contacts, deals, pipelines.", logo: null, categories: ["Sales"], authSchemes: ["oauth2"], noAuth: false },
    { slug: "googledrive", name: "Google Drive", description: "Search and read Drive files.", logo: null, categories: ["Productivity"], authSchemes: ["oauth2"], noAuth: false },
  ];
}

export async function initiateConnection(_userId: string, _toolkitSlug: string, _callbackUrl?: string) {
  return { redirectUrl: null, connectedAccountId: null, status: "stub" };
}

export async function listConnectedAccounts(_userId: string): Promise<any[]> {
  return [];
}

export async function deleteConnection(_id: string) { return false; }

export async function getComposioTools(_userId: string, _toolkits: string[]) {
  return [] as { name: string; description: string; input_schema: any }[];
}

export async function executeComposioTool(_userId: string, _name: string, _input: any): Promise<string> {
  return "Composio integration is not yet wired up — coming soon.";
}
