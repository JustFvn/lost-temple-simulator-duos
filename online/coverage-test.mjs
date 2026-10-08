import assert from "node:assert/strict";
import { LAYOUTS } from "./public/layouts.js";
import { allPaths, roomCX, roomCY, GAPS } from "./public/geometry.js";
import { coveragePlan, createCoverage, advanceCoverage, coverageProgress } from "./public/route-coverage.js";
const center = room => ({ x: roomCX(room), y: roomCY(room) });
for (const [, ids] of LAYOUTS) {
  const open = new Set(ids), plan = coveragePlan(open), tracker = createCoverage(), other = createCoverage();
  const paths = allPaths(open); let point = center(22);
  const walk = path => {
    for (const room of path) {
      const next = center(room);
      assert(advanceCoverage(tracker, plan, point, next).valid); point = next;
    }
  };
  walk(paths[0]); assert(!coverageProgress(tracker, plan).ready, "只走一條路不能拿王冠");
  assert.equal(other.doors.size, 0, "各人的進度獨立");
  walk([...paths[1]].reverse()); assert(coverageProgress(tracker, plan).ready);
  const count = tracker.doors.size; walk(paths[0]); assert.equal(tracker.doors.size, count, "反覆走不重複計分");
  assert(count <= ids.length); assert.equal(count, plan.required.size);
}
const plan = coveragePlan(new Set(LAYOUTS[12][1])), tracker = createCoverage(), start = center(22);
assert(!advanceCoverage(tracker, plan, start, center(21)).valid, "穿過假門不能計進度");
assert(!advanceCoverage(tracker, plan, start, center(2)).valid, "不能穿過 A3–B3 實牆瞬移終點");
assert.equal(tracker.doors.size, 0);
const gap = GAPS[18], middle = { x: gap.x + gap.w / 2, y: gap.y + gap.h / 2 };
assert(advanceCoverage(tracker, plan, start, middle).valid);
assert.equal(tracker.doors.size, 0, "只碰到門沒有穿到下一房不算走過路段");
assert(advanceCoverage(tracker, plan, middle, start).valid);
assert.equal(tracker.doors.size, 0, "進入門縫又退回不算走過");
assert(advanceCoverage(tracker, plan, start, center(23)).valid);
assert.equal(tracker.doors.size, 1);
assert.equal(createCoverage().doors.size, 0, "新回合清零");
console.log("OK: 125 張官方佈局全路段可完成、雙路線去重、個人進度、只碰門不算、閉門／穿牆拒絕與新回合清零。");
