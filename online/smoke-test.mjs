import fs from "node:fs";
import assert from "node:assert/strict";
import { LAYOUTS, DOORS } from "./public/layouts.js";
import { allPaths } from "./public/geometry.js";

const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("./public/client.js", import.meta.url), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const refs = [...client.matchAll(/\$\("#([^"]+)"\)/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, "HTML ID 不可重複");
assert.deepEqual([...new Set(refs.filter(id => !ids.includes(id)))], [], "所有介面參照都必須存在");
assert.equal(LAYOUTS.length, 125);
assert.equal(DOORS.length, 39);
for (const layout of LAYOUTS) assert.equal(allPaths(new Set(layout[1])).length, 2);
assert.match(html, /type="module" src="client.js"/);
assert.doesNotMatch(html, /lobbyOverlay|settingsOverlay|resultOverlay|modal-backdrop/);
console.log(`OK: ${ids.length} 個 GUI ID、125 張官方佈局與獨立頁面結構。`);
