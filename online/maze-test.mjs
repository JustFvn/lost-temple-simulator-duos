import assert from "node:assert/strict";
import { generateMaze } from "./maze.js";
import { DOORS, LAYOUTS } from "./public/layouts.js";
import { allPaths, buildWalls, roomCX, roomCY, PR } from "./public/geometry.js";

let seed = 726401;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const signatures = new Set(), official = new Set(LAYOUTS.map(layout => [...layout[1]].sort((a, b) => a - b).join(",")));
let newMaps = 0;
function assertNoDeadEnds(open, paths) {
  const degrees = new Int8Array(25);
  const key = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;
  const routeEdges = new Set(paths.flatMap(path => path.slice(1).map((room, i) => key(path[i], room))));
  const openEdges = new Set();
  for (const id of open) {
    const [r1, c1, r2, c2] = DOORS[id], a = r1 * 5 + c1, b = r2 * 5 + c2;
    degrees[a]++; degrees[b]++; openEdges.add(key(a, b));
  }
  assert(degrees.every(degree => degree === 0 || degree === 2), "可進入的房間不可有死路或額外支線");
  assert.deepEqual(openEdges, routeEdges, "所有開啟的門都必須屬於兩條通關路線");
}
for (let trial = 0; trial < 1000; trial++) {
  const maze = generateMaze(random), open = new Set(maze.openDoors), paths = allPaths(open);
  signatures.add(maze.openDoors.join(","));
  if (!official.has(maze.openDoors.join(","))) newMaps++;
  assert.equal(open.size, maze.openDoors.length);
  assert(maze.openDoors.every(id => Number.isInteger(id) && id >= 0 && id < DOORS.length));
  assert.equal(paths.length, 2, "必須恰有兩條通關路線");
  assertNoDeadEnds(open, paths);
  assert.notEqual(paths[0][1], paths[1][1], "起點即有左右兩條分岔");
  assert(!paths[0].slice(1, -1).some(room => paths[1].slice(1, -1).includes(room)), "兩條主路線中途不交叉");
  assert.deepEqual(maze.routeLengths, paths.map(path => path.length - 1));
  const walls = buildWalls(open);
  for (const path of paths) {
    assert.equal(path[0], 22); assert.equal(path.at(-1), 2);
    for (let i = 1; i < path.length; i++) {
      // A radius-10 player must physically fit along every room-center corridor.
      const x1 = roomCX(path[i - 1]), y1 = roomCY(path[i - 1]), x2 = roomCX(path[i]), y2 = roomCY(path[i]);
      for (let t = 0; t <= 1; t += 1 / 40) {
        const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
        assert(!walls.some(wall => Math.hypot(x - Math.max(wall.x, Math.min(x, wall.x + wall.w)), y - Math.max(wall.y, Math.min(y, wall.y + wall.h))) < PR), "路線不可被實牆擋住");
      }
    }
  }
}
assert(signatures.size > 200, "應有足夠地圖變化");
assert(newMaps > 900, "不可只抽官方地圖");
for (const constant of [0, 0.5, 0.999999]) {
  const open = new Set(generateMaze(() => constant).openDoors), paths = allPaths(open);
  assert.equal(paths.length, 2); assertNoDeadEnds(open, paths);
}
console.log(`OK: 1000 張生成地圖，${signatures.size} 種不同佈局；無死路，恰有兩條分岔且碰撞幾何可通關。`);
