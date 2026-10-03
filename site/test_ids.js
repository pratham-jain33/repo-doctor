/* Guards against dead element references: every id passed to getElementById
   in app.js must exist in index.html. A missing one throws at runtime and
   the button silently does nothing — exactly how the Groq connect button
   broke when #groq-promo was removed from the HTML but not the JS.
   Run: node test_ids.js */
const fs = require("fs");
const js = fs.readFileSync("./app.js", "utf8");
const html = fs.readFileSync("./index.html", "utf8");
const ids = new Set();
for (const m of js.matchAll(/getElementById\("([^"]+)"\)/g)) ids.add(m[1]);
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(m[1]);
let fail = 0;
for (const id of [...ids].sort()) {
  if (!html.includes(`id="${id}"`)) {
    console.log("FAIL: app.js references missing element #" + id);
    fail++;
  }
}
console.log(fail ? `${fail} missing element(s)` : `${ids.size} ids checked, all present in index.html`);
process.exit(fail ? 1 : 0);
