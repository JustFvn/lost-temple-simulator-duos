import assert from "node:assert/strict";
import { DOORS } from "./public/layouts.js";
import { ROOM, WALL, DOOR, PR, GAPS, buildWalls, roomCX, roomCY } from "./public/geometry.js";

assert(DOOR > 2 * PR && DOOR <= ROOM - 2 * PR, "門口需容納角色並保留兩側實牆");
const openWalls = buildWalls(new Set(DOORS.map((_, id) => id))), closedWalls = buildWalls(new Set());
const collides = (walls, x, y) => walls.some(w => Math.hypot(x - Math.max(w.x, Math.min(x, w.x + w.w)), y - Math.max(w.y, Math.min(y, w.y + w.h))) < PR - 1e-6);
for (const [id, [r, c, rr, cc]] of DOORS.entries()) {
  const a = r * 5 + c, b = rr * 5 + cc, gap = GAPS[id], horizontal = r === rr;
  assert.equal(horizontal ? gap.h : gap.w, DOOR, "畫面門口與實際通行寬度一致");
  assert.equal(horizontal ? gap.w : gap.h, WALL);
  assert.equal(gap.x + gap.w / 2, (roomCX(a) + roomCX(b)) / 2);
  assert.equal(gap.y + gap.h / 2, (roomCY(a) + roomCY(b)) / 2);
  // Test near both jambs, not just the center: the radius-10 body must fit.
  for (const offset of [-DOOR / 2 + PR + 1, 0, DOOR / 2 - PR - 1]) {
    for (let step = 0; step <= 40; step++) {
      const x = roomCX(a) + (roomCX(b) - roomCX(a)) * step / 40 + (horizontal ? 0 : offset);
      const y = roomCY(a) + (roomCY(b) - roomCY(a)) * step / 40 + (horizontal ? offset : 0);
      assert(!collides(openWalls, x, y), `門 ${id} 加寬區域必須可通行`);
    }
    const x = gap.x + gap.w / 2 + (horizontal ? 0 : offset), y = gap.y + gap.h / 2 + (horizontal ? offset : 0);
    assert(collides(closedWalls, x, y), "假門加寬後仍不能穿過");
  }
  const offset = DOOR / 2 - PR + 1;
  assert(collides(openWalls, gap.x + gap.w / 2 + (horizontal ? 0 : offset), gap.y + gap.h / 2 + (horizontal ? offset : 0)), "角色碰到門框仍應被擋住");
}
assert(collides(openWalls, 410, 650), "A3–B3 永久實牆不可開洞");
assert(collides(openWalls, 10, 90), "外牆不可穿越");
console.log("OK: 39 個門口畫面／碰撞一致、中心與加寬邊緣可通行、假門與門框阻擋、永久實牆及外牆保留。");
