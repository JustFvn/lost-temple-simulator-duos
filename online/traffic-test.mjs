import assert from "node:assert/strict";
import { createTrafficSchedule, trafficState } from "./public/traffic.js";
for (let n = 0; n < 1000; n++) {
  const schedule = createTrafficSchedule();
  assert.equal(schedule.length, 48);
  let elapsed = 0;
  for (let i = 0; i < schedule.length; i++) {
    const item = schedule[i];
    assert.equal(item.phase, ["green", "yellow", "red"][i % 3]);
    assert(item.duration >= (item.phase === "green" ? 3000 : item.phase === "red" ? 2000 : 800));
    assert(item.duration <= (item.phase === "green" ? 5000 : item.phase === "red" ? 3500 : 800));
    assert.equal(trafficState(schedule, elapsed).index, i);
    assert.equal(trafficState(schedule, elapsed + item.duration - 1).phase, item.phase);
    elapsed += item.duration;
  }
  assert.equal(trafficState(schedule, elapsed).index, 48);
  assert.equal(trafficState(schedule, elapsed * 100 + 5).index, 4800);
  assert.equal(trafficState(schedule, -100).phase, "green");
}
console.log("OK: 1000 組紅綠燈時程、黃燈預告、精確切換邊界、循環與雙方共用時間計算。");
