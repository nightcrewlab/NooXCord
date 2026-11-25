import assert from "node:assert/strict";
import { extractUrls, isPrivate, proxiedImage, proxyImage, setProxyKey, unfurl } from "../src/unfurl";
setProxyKey(Buffer.alloc(32, 7));

assert.deepEqual(extractUrls("bak https://a.test/x), ve http://b.test."), ["https://a.test/x", "http://b.test"]);
for (const u of ["http://127.0.0.1:47820/api/info", "http://localhost/", "http://[::1]/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://25.1.2.3/", "file:///C:/Windows/win.ini",
  // IPv6 spellings of IPv4 addresses (the URL parser turns the first into [::ffff:7f00:1]), NAT64, 6to4, unique-local
  "http://[::ffff:127.0.0.1]:47820/api/info", "http://[::ffff:a9fe:a9fe]/latest/meta-data", "http://[::7f00:1]/", "http://[64:ff9b::7f00:1]/",
  "http://[2002:7f00:1::]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://2130706433/", "http://0x7f.1/"]) {
  assert.equal(await unfurl(u), null, u);
}
for (const ip of ["8.8.8.8", "::ffff:8.8.8.8", "2606:4700:4700::1111", "172.32.0.1"]) assert.equal(isPrivate(ip), false, ip);
console.log("  ✓ private / loopback / link-local / Hamachi / IPv4-in-IPv6 / file URLs blocked, public ones not");
const ex = await unfurl("https://example.com/");
console.log("  example.com ->", JSON.stringify(ex));
assert.ok(ex?.title, "public page preview");
console.log("  ✓ public page preview works");
const link = proxiedImage("http://127.0.0.1:47820/secret.png");
const [, , , sig, enc] = link.split("/");
assert.equal(await proxyImage("A".repeat(22), enc!, () => "image/png"), null, "bad signature");
assert.equal(await proxyImage(sig!, enc!, () => "image/png"), null, "signed but private");
console.log("  ✓ image proxy: signed links only, private targets refused\nUNFURL PASS");
