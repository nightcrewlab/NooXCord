import assert from "node:assert/strict";
import { extractUrls, unfurl } from "../src/unfurl";

assert.deepEqual(extractUrls("bak https://a.test/x), ve http://b.test."), ["https://a.test/x", "http://b.test"]);
for (const u of ["http://127.0.0.1:47820/api/info", "http://localhost/", "http://[::1]/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://25.1.2.3/", "file:///C:/Windows/win.ini"]) {
  assert.equal(await unfurl(u), null, u);
}
console.log("  ✓ private / loopback / link-local / Hamachi / file URLs blocked");
const ex = await unfurl("https://example.com/");
console.log("  example.com ->", JSON.stringify(ex));
assert.ok(ex?.title, "public page preview");
console.log("  ✓ public page preview works\nUNFURL PASS");
