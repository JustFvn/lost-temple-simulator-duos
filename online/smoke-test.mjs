import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const refs = [...html.matchAll(/\$\("#([^"]+)"\)/g)].map(match => match[1]);

for (const [index, source] of scripts.entries()) {
  new vm.Script(source, { filename: `inline-script-${index}.js` });
}

const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
const missingIds = [...new Set(refs.filter(id => !ids.includes(id)))];
const layouts = JSON.parse(html.match(/const LAYOUTS = (\[[\s\S]*?\n\]);/)[1].replace(/,\s*]$/, "]"));

if (layouts.length !== 125 || duplicateIds.length || missingIds.length) {
  console.error({ layoutCount: layouts.length, duplicateIds, missingIds });
  process.exitCode = 1;
} else {
  console.log(`OK: ${scripts.length} 段 JavaScript、${ids.length} 個 id、${layouts.length} 種佈局。`);
}
