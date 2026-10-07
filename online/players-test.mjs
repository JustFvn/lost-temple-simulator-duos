import assert from "node:assert/strict";
import { MAX_PLAYERS, PLAYER_STYLES, emptyScores, spawnPosition, availableSlot } from "./public/players.js";
import { PR, roomCX, roomCY, START_I } from "./public/geometry.js";
assert.equal(MAX_PLAYERS, 4); assert.equal(new Set(PLAYER_STYLES.map(style => style.color)).size, 4);
const a = emptyScores(), b = emptyScores(); a[3] = 1; assert.deepEqual(b, [0, 0, 0, 0]);
for (let slot = 0; slot < MAX_PLAYERS; slot++) {
  const p = spawnPosition(slot);
  assert(Math.abs(p.x - roomCX(START_I)) < 70 - PR && Math.abs(p.y - roomCY(START_I)) < 70 - PR);
  for (let other = 0; other < slot; other++) assert(Math.hypot(p.x - spawnPosition(other).x, p.y - spawnPosition(other).y) > PR * 2);
}
assert.equal(availableSlot([]), 0); assert.equal(availableSlot([{ slot: 0 }, { slot: 2 }, { slot: 3 }]), 1);
assert.equal(availableSlot([0, 1, 2, 3].map(slot => ({ slot }))), -1);
console.log("OK: 四種角色顏色、起點不重疊且不撞牆、獨立比分與離房後補空席位。");
