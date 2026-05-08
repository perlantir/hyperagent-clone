import type { Connector } from "./types";

// Static registry of available connectors. Each declares the credential
// fields it needs and the tools it exposes when configured.
export const CONNECTORS: Record<string, Connector> = {
  slack: {
    id: "slack", name: "Slack", description: "Send messages to Slack channels, read recent activity.",
    category: "Communication", icon: "S", color: "#fef3c7", textColor: "#92400e",
    credentialFields: [{ name: "botToken", label: "Bot User Token (xoxb-…)", type: "password" }],
    tools: ["slack_send_message"],
  },
  gmail: {
    id: "gmail", name: "Gmail", description: "Search inbox, draft replies, send email.",
    category: "Communication", icon: "G", color: "#fee2e2", textColor: "#991b1b",
    credentialFields: [{ name: "appPassword", label: "App password", type: "password" }, { name: "email", label: "Email address", type: "text" }],
    tools: ["gmail_search", "gmail_send"],
  },
  linear: {
    id: "linear", name: "Linear", description: "Read issues, search cycles, create tasks.",
    category: "Productivity", icon: "L", color: "#ede9fe", textColor: "#5b21b6",
    credentialFields: [{ name: "apiKey", label: "API key", type: "password" }],
    tools: ["linear_search_issues", "linear_create_issue"],
  },
  notion: {
    id: "notion", name: "Notion", description: "Read pages, append blocks, search database rows.",
    category: "Productivity", icon: "N", color: "#dbeafe", textColor: "#1e40af",
    credentialFields: [{ name: "apiKey", label: "Integration token", type: "password" }],
    tools: ["notion_search", "notion_append"],
  },
  stripe: {
    id: "stripe", name: "Stripe", description: "Read charges, customers, subscriptions.",
    category: "Finance", icon: "$", color: "#fce7f3", textColor: "#9d174d",
    credentialFields: [{ name: "apiKey", label: "Secret key", type: "password" }],
    tools: ["stripe_list_charges", "stripe_get_customer"],
  },
  github: {
    id: "github", name: "GitHub", description: "Search repos, read issues, create PRs.",
    category: "Developer", icon: "G", color: "#1f2937", textColor: "#f3f4f6",
    credentialFields: [{ name: "token", label: "Personal access token", type: "password" }],
    tools: ["github_search", "github_create_issue"],
  },
  airtable: {
    id: "airtable", name: "Airtable", description: "Read and write Airtable bases.",
    category: "Productivity", icon: "A", color: "#cffafe", textColor: "#155e75",
    credentialFields: [{ name: "apiKey", label: "Personal access token", type: "password" }, { name: "baseId", label: "Base ID", type: "text" }],
    tools: ["airtable_list_records", "airtable_create_record"],
  },
  hubspot: {
    id: "hubspot", name: "HubSpot", description: "CRM contacts, deals, pipelines.",
    category: "Sales", icon: "H", color: "#fed7aa", textColor: "#9a3412",
    credentialFields: [{ name: "apiKey", label: "Private app token", type: "password" }],
    tools: ["hubspot_search_contacts", "hubspot_create_deal"],
  },
  googledrive: {
    id: "googledrive", name: "Google Drive", description: "Search and read Drive files.",
    category: "Productivity", icon: "D", color: "#dcfce7", textColor: "#166534",
    credentialFields: [{ name: "oauthToken", label: "OAuth token", type: "password" }],
    tools: ["drive_search", "drive_read"],
  },
  postgres: {
    id: "postgres", name: "Postgres", description: "Run read-only queries on a Postgres database.",
    category: "Developer", icon: "Pg", color: "#dbeafe", textColor: "#1e3a8a",
    credentialFields: [{ name: "connectionString", label: "Connection string", type: "password" }],
    tools: ["pg_query"],
  },
};

export function listConnectors(): Connector[] {
  return Object.values(CONNECTORS);
}
export function getConnector(id: string): Connector | null {
  return CONNECTORS[id] || null;
}
