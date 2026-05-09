// P64.1 — codex bridge URL safety / SSRF guards.
//
// Validates that:
//   - validateForServerSideFetch refuses every SSRF target (loopback,
//     RFC1918, link-local, ULA, *.local, broadcast, unspecified, cloud
//     metadata IPs)
//   - validateForServerSideFetch refuses ws:// + http:// (plaintext
//     against a public host is never OK)
//   - validateForBrowserOrLocal allows loopback + private but refuses
//     cloud metadata IPs
//   - validateForBrowserOrLocal refuses ws:// for public hosts
//   - inferConnectionLocationFromUrl maps URL classes correctly
//   - verifyResolvedIp catches DNS rebinding to private space
//   - All validators reject non-URLs, missing host, and weird schemes

import {
  validateForServerSideFetch,
  validateForBrowserOrLocal,
  classifyHost,
  isCloudMetadataIp,
  inferConnectionLocationFromUrl,
  verifyResolvedIp,
} from "../codex/url-safety";

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

(async () => {
  // ─── classifyHost ─────────────────────────────────────────────────
  pass("classifyHost localhost",          classifyHost("localhost") === "loopback");
  pass("classifyHost 127.0.0.1",          classifyHost("127.0.0.1") === "loopback");
  pass("classifyHost 127.5.6.7",          classifyHost("127.5.6.7") === "loopback");
  pass("classifyHost ::1",                classifyHost("::1") === "loopback");
  pass("classifyHost 10.0.0.1",           classifyHost("10.0.0.1") === "private");
  pass("classifyHost 10.255.255.255",     classifyHost("10.255.255.255") === "private");
  pass("classifyHost 172.16.0.1",         classifyHost("172.16.0.1") === "private");
  pass("classifyHost 172.31.255.255",     classifyHost("172.31.255.255") === "private");
  pass("classifyHost 172.15.0.1 NOT priv",classifyHost("172.15.0.1") === "public");
  pass("classifyHost 172.32.0.1 NOT priv",classifyHost("172.32.0.1") === "public");
  pass("classifyHost 192.168.1.1",        classifyHost("192.168.1.1") === "private");
  pass("classifyHost 192.169.0.1 public", classifyHost("192.169.0.1") === "public");
  pass("classifyHost 169.254.0.5 link",   classifyHost("169.254.0.5") === "linklocal");
  pass("classifyHost 169.254.169.254 metadata", classifyHost("169.254.169.254") === "metadata");
  pass("classifyHost 100.100.100.200 metadata (Alibaba)",
    classifyHost("100.100.100.200") === "metadata");
  pass("classifyHost metadata.google.internal",
    classifyHost("metadata.google.internal") === "metadata");
  pass("classifyHost myapp.local mDNS",   classifyHost("myapp.local") === "mdns");
  pass("classifyHost foo.localhost loopback",
    classifyHost("foo.localhost") === "loopback");
  pass("classifyHost example.com public", classifyHost("example.com") === "public");
  pass("classifyHost fc00:bad::1 ULA",    classifyHost("fc00:bad::1") === "ula");
  pass("classifyHost fd12:3456:789a::1 ULA",
    classifyHost("fd12:3456:789a::1") === "ula");
  pass("classifyHost fe80::1 link-local IPv6",
    classifyHost("fe80::1") === "linklocal");
  pass("classifyHost fd00:ec2::254 metadata (AWS IMDSv2 IPv6)",
    classifyHost("fd00:ec2::254") === "metadata");
  pass("classifyHost 0.0.0.0 broadcast",  classifyHost("0.0.0.0") === "broadcast");
  pass("classifyHost 0.5.6.7 broadcast (0/8)", classifyHost("0.5.6.7") === "broadcast");
  pass("classifyHost 8.8.8.8 public",     classifyHost("8.8.8.8") === "public");
  pass("classifyHost empty unknown",      classifyHost("") === "unknown");

  // IPv6 zone-id stripping
  pass("classifyHost fe80::1%eth0 link-local",
    classifyHost("fe80::1%eth0") === "linklocal");

  // ─── isCloudMetadataIp ────────────────────────────────────────────
  pass("isCloudMetadataIp 169.254.169.254",  isCloudMetadataIp("169.254.169.254") === true);
  pass("isCloudMetadataIp 169.254.170.2 ECS",isCloudMetadataIp("169.254.170.2") === true);
  pass("isCloudMetadataIp metadata.google.internal",
    isCloudMetadataIp("metadata.google.internal") === true);
  pass("isCloudMetadataIp 10.0.0.1 not metadata",
    isCloudMetadataIp("10.0.0.1") === false);
  pass("isCloudMetadataIp empty false",      isCloudMetadataIp("") === false);

  // ─── validateForServerSideFetch ───────────────────────────────────
  // Refuses every SSRF target
  for (const bad of [
    "ws://127.0.0.1:8345",
    "ws://localhost:8345",
    "ws://10.0.0.1",
    "ws://192.168.1.1",
    "ws://172.16.0.1",
    "ws://169.254.169.254",       // AWS metadata
    "wss://169.254.169.254",
    "wss://metadata.google.internal",
    "ws://[::1]:8345",
    "ws://[fe80::1]",
    "ws://[fc00::1]",
    "ws://0.0.0.0",
    "ws://my-machine.local",
    "wss://10.0.0.1",
  ]) {
    const r = validateForServerSideFetch(bad);
    pass(`server-side blocks ${bad}`, r.ok === false, r.ok ? "(unexpectedly passed)" : "");
  }

  // Refuses plaintext over public
  pass("server-side refuses ws:// to public",
    validateForServerSideFetch("ws://example.com:8345").ok === false);
  pass("server-side refuses http:// scheme",
    validateForServerSideFetch("http://example.com").ok === false);
  pass("server-side accepts wss:// to public DNS",
    validateForServerSideFetch("wss://my-tunnel.ngrok.io").ok === true);
  pass("server-side accepts wss:// to public IPv4",
    validateForServerSideFetch("wss://8.8.8.8").ok === true);
  pass("server-side accepts https:// for HTTP probes",
    validateForServerSideFetch("https://my-tunnel.example.com").ok === true);

  // Reject malformed
  pass("server-side rejects malformed URL",
    validateForServerSideFetch("not-a-url").ok === false);
  pass("server-side rejects empty string",
    validateForServerSideFetch("").ok === false);

  // ─── validateForBrowserOrLocal ────────────────────────────────────
  // Loopback + private allowed
  for (const ok of [
    "ws://127.0.0.1:8345",
    "ws://localhost:8345",
    "ws://[::1]:8345",
    "ws://10.0.0.1:8345",
    "ws://192.168.1.50:8345",
    "ws://172.16.0.1:8345",
    "ws://my-machine.local:8345",
    "wss://my-machine.local:8345",
  ]) {
    const r = validateForBrowserOrLocal(ok);
    pass(`browser-or-local accepts ${ok}`, r.ok === true,
      r.ok ? "" : (r as any).reason);
  }

  // Cloud metadata still blocked everywhere
  pass("browser-or-local blocks AWS metadata",
    validateForBrowserOrLocal("ws://169.254.169.254:8345").ok === false);
  pass("browser-or-local blocks GCP metadata host",
    validateForBrowserOrLocal("wss://metadata.google.internal:8345").ok === false);
  pass("browser-or-local blocks AWS IMDSv2 IPv6",
    validateForBrowserOrLocal("ws://[fd00:ec2::254]:8345").ok === false);

  // ws:// to public hosts blocked
  pass("browser-or-local blocks ws:// to public DNS",
    validateForBrowserOrLocal("ws://example.com:8345").ok === false);
  // wss:// to public hosts allowed (user's own VPS scenario)
  pass("browser-or-local accepts wss:// to public DNS",
    validateForBrowserOrLocal("wss://my-vps.example.com:8345").ok === true);

  // Other schemes refused
  pass("browser-or-local refuses http://",
    validateForBrowserOrLocal("http://localhost:8345").ok === false);
  pass("browser-or-local refuses https://",
    validateForBrowserOrLocal("https://localhost:8345").ok === false);

  // ─── inferConnectionLocationFromUrl ───────────────────────────────
  pass("infer 127.0.0.1 → browser",
    inferConnectionLocationFromUrl("ws://127.0.0.1:8345") === "browser");
  pass("infer 10.0.0.1 → browser",
    inferConnectionLocationFromUrl("ws://10.0.0.1:8345") === "browser");
  pass("infer my-tunnel.ngrok.io → tunnel",
    inferConnectionLocationFromUrl("wss://my-tunnel.ngrok.io") === "tunnel");
  pass("infer broken URL → unknown",
    inferConnectionLocationFromUrl("garbage") === "unknown");

  // ─── verifyResolvedIp (DNS rebinding guard) ───────────────────────
  // localhost resolves to 127.0.0.1 — must be flagged.
  {
    const r = await verifyResolvedIp("localhost");
    pass("verifyResolvedIp blocks localhost (resolves to loopback)",
      r.ok === false && /loopback/i.test((r as any).reason || ""));
  }
  // 127.0.0.1 itself
  {
    const r = await verifyResolvedIp("127.0.0.1");
    pass("verifyResolvedIp blocks 127.0.0.1",
      r.ok === false);
  }
  // A private DNS name that doesn't resolve.
  {
    const r = await verifyResolvedIp("does-not-exist-xyz.invalid");
    pass("verifyResolvedIp fails closed when DNS lookup fails",
      r.ok === false);
  }
  // Public IP that genuinely resolves to itself.
  {
    const r = await verifyResolvedIp("8.8.8.8");
    pass("verifyResolvedIp accepts 8.8.8.8 (public)", r.ok === true);
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll url-safety tests passed.");
})();
