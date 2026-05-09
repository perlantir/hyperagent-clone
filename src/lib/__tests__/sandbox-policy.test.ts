// P34 — sandbox-policy tests for the pure functions: extractHosts +
// hostAllowed. Policy enforcement (concurrency / per-minute) hits the DB
// and is exercised via the integration build.

import { extractHosts, hostAllowed } from "../sandbox-policy";

function pass(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL:", label); process.exit(1); }
  console.log("PASS:", label);
}

// ============ extractHosts ============

// Plain HTTPS URL
pass("extracts simple https URL",
  extractHosts("import requests\nrequests.get('https://api.openai.com/v1/chat')").includes("api.openai.com"));

// Multiple URLs in same script
const multi = `
import requests
r1 = requests.get('https://api.openai.com/x')
r2 = requests.get('https://api.anthropic.com/y')
`;
const multiHosts = extractHosts(multi);
pass("extracts multiple distinct URLs",
  multiHosts.includes("api.openai.com") && multiHosts.includes("api.anthropic.com"));

// Bare-quoted host in a fetch
pass("extracts host from urlopen()",
  extractHosts(`urllib.request.urlopen("https://example.org/data.json")`).includes("example.org"));

// curl shell command
pass("extracts host from curl command",
  extractHosts(`curl -s https://github.com/foo/bar`).includes("github.com"));

// curl with flags before the URL
pass("curl flags don't confuse extraction",
  extractHosts(`curl -X POST -H 'auth: x' https://api.stripe.com/charges`).includes("api.stripe.com"));

// IPv4 (non-loopback) surfaces
pass("ipv4 address surfaces",
  extractHosts(`fetch("http://192.168.1.5:8080/")`).includes("192.168.1.5"));

// Loopback / 0.0.0.0 do not surface (they're local — not network egress)
const loop = extractHosts(`requests.get('http://127.0.0.1:5000/')`);
pass("127.0.0.1 not flagged as remote host", !loop.includes("127.0.0.1"));

// No URL → empty
pass("plain math returns no hosts", extractHosts("print(1 + 2)").length === 0);

// Hostname with port
pass("port stripped from host",
  extractHosts(`requests.get('https://api.openai.com:443/')`).includes("api.openai.com"));

// Credentials in URL stripped
pass("credentials stripped",
  extractHosts(`requests.get('https://user:pass@api.openai.com/')`).includes("api.openai.com"));

// localhost
pass("localhost surfaces",
  extractHosts(`requests.get('http://localhost:3000/')`).includes("localhost"));

// Deduplication
const dupSrc = "curl https://github.com/x; curl https://github.com/y";
const dup = extractHosts(dupSrc);
pass("duplicates deduplicated",
  dup.filter(h => h === "github.com").length === 1);

// fetch in JS-shaped code (the agent might call run_shell with node)
pass("fetch() extracts host",
  extractHosts(`await fetch("https://registry.npmjs.org/express")`).includes("registry.npmjs.org"));

// ============ hostAllowed ============

const allowlist = ["api.openai.com", "github.com"];

pass("exact host allowed", hostAllowed("api.openai.com", allowlist));
pass("subdomain allowed under apex",
  hostAllowed("raw.githubusercontent.com", ["githubusercontent.com"]));
pass("subdomain allowed under api.openai.com",
  hostAllowed("metrics.api.openai.com", allowlist));
pass("unrelated host denied",
  !hostAllowed("evil.com", allowlist));
pass("partial match (suffix-only) NOT allowed without subdomain boundary",
  !hostAllowed("notapi.openai.com", allowlist));
pass("wildcard *.example.com matches",
  hostAllowed("a.example.com", ["*.example.com"]));
pass("wildcard does not match apex automatically",
  !hostAllowed("example.com", ["*.example.com"]));
pass("apex-form covers itself + subs",
  hostAllowed("example.com", ["example.com"]) &&
  hostAllowed("a.example.com", ["example.com"]));
pass("case-insensitive",
  hostAllowed("API.OpenAI.com", allowlist));

console.log("\nAll P34 sandbox-policy tests passed.");
