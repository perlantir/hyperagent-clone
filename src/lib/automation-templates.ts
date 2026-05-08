import type { AutomationTemplate } from "./types";

// Pre-built automation recipes. User picks one, customizes the prompt, sets
// schedule, and a Schedule + Run loop is created.
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "competitor_pricing_watch",
    name: "Competitor pricing watch",
    description: "Check competitor pricing pages every hour and surface changes.",
    category: "Sales",
    agentColor: "green",
    defaultIntervalMinutes: 60,
    prompt: "Check the pricing pages of [competitors]. Compare against the snapshot from the last run. Surface only material changes — list price, new tiers, deprecated plans. If nothing changed, say so in one line.",
    recommendedTools: ["web_search"],
  },
  {
    id: "morning_news_digest",
    name: "Morning news digest",
    description: "Pull top stories in your space and post a 5-bullet digest at 7am.",
    category: "Research",
    agentColor: "orange",
    defaultIntervalMinutes: 60 * 24,
    prompt: "Search for top news in [topic] from the last 24 hours. Pick the 5 most consequential. For each: 1-line headline, 1-line so-what. Skip filler.",
    recommendedTools: ["web_search", "generate_artifact"],
  },
  {
    id: "support_inbox_triage",
    name: "Support inbox triage",
    description: "Read the support queue every 30 min and tag urgent items.",
    category: "Operations",
    agentColor: "blue",
    defaultIntervalMinutes: 30,
    prompt: "Read recent items in the support queue. Classify as: urgent / blocking / informational. For urgent items, draft a one-line first response.",
    recommendedTools: ["gmail_search"],
  },
  {
    id: "github_release_watch",
    name: "GitHub release watch",
    description: "Monitor key repos for new releases. Summarize changes.",
    category: "Developer",
    agentColor: "purple",
    defaultIntervalMinutes: 60 * 6,
    prompt: "Check repos [repo list] for new releases since the last run. For each, summarize the headline changes in 1-2 bullets. Flag breaking changes.",
    recommendedTools: ["github_search", "web_search"],
  },
  {
    id: "weekly_okr_digest",
    name: "Weekly OKR digest",
    description: "Pull Linear cycle status every Monday morning.",
    category: "Productivity",
    agentColor: "blue",
    defaultIntervalMinutes: 60 * 24 * 7,
    prompt: "Pull the current Linear cycles. Group by team. Compute completion ratio. Surface blockers. Output as a section per team.",
    recommendedTools: ["linear_search_issues"],
  },
  {
    id: "stripe_revenue_pulse",
    name: "Stripe revenue pulse",
    description: "Compare yesterday's net revenue to the 7-day average.",
    category: "Finance",
    agentColor: "green",
    defaultIntervalMinutes: 60 * 24,
    prompt: "Pull Stripe charges from yesterday. Compare net revenue to the trailing 7-day average. If it deviated >20%, flag and explain. Otherwise say 'normal'.",
    recommendedTools: ["stripe_list_charges"],
  },
  {
    id: "executive_assistant",
    name: "Executive assistant",
    description: "Triage email and Slack DMs every morning at 8am.",
    category: "Productivity",
    agentColor: "purple",
    defaultIntervalMinutes: 60 * 24,
    prompt: "Read the user's inbox and Slack DMs from the last 24 hours. Output: 1) Things requiring response today (with one-line draft), 2) Things requiring response this week, 3) FYIs.",
    recommendedTools: ["gmail_search"],
  },
  {
    id: "social_mention_monitor",
    name: "Social mention monitor",
    description: "Watch for mentions of your brand across the web.",
    category: "Marketing",
    agentColor: "orange",
    defaultIntervalMinutes: 60 * 4,
    prompt: "Search for new mentions of [brand]. Filter to actual references (not generic word use). Group as: positive, negative, neutral. Surface posts >100 engagements.",
    recommendedTools: ["web_search"],
  },
];

export function getAutomationTemplate(id: string): AutomationTemplate | null {
  return AUTOMATION_TEMPLATES.find(t => t.id === id) || null;
}
