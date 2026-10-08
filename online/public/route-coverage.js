import { DOORS } from "./layouts.js";
import { ROOM, WALL, START_I, pos, allPaths, buildWalls } from "./geometry.js";

const edgeKey = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;
const doorByEdge = new Map(DOORS.map(([r, c, rr, cc], id) => [edgeKey(r * 5 + c, rr * 5 + cc), id]));

// Only segments on a start-to-crown route are required; shared segments count once.
export function coveragePlan(open) {
  const required = new Set();
  for (const path of allPaths(open)) {
    for (let i = 1; i < path.length; i++) required.add(doorByEdge.get(edgeKey(path[i - 1], path[i])));
  }
  return { required, walls: buildWalls(open) };
}

export function createCoverage() {
  return { room: START_I, doors: new Set() };
}

function roomAt({ x, y }) {
  const c = Math.floor((x - WALL) / (ROOM + WALL)), r = Math.floor((y - WALL) / (ROOM + WALL));
  if (r < 0 || r > 4 || c < 0 || c > 4 || x > pos(c) + ROOM || y > pos(r) + ROOM) return null;
  return r * 5 + c;
}

// Sample the complete position segment, not just the reported destination.
// Crossing a closed door / solid wall gives no credit and does not mutate progress.
export function advanceCoverage(tracker, plan, from, to) {
  const samples = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
  let room = tracker.room;
  const crossed = new Set();
  for (let i = 1; i <= samples; i++) {
    const point = { x: from.x + (to.x - from.x) * i / samples, y: from.y + (to.y - from.y) * i / samples };
    if (plan.walls.some(w => point.x >= w.x && point.x <= w.x + w.w && point.y >= w.y && point.y <= w.y + w.h)) return { valid: false, changed: false };
    const next = roomAt(point);
    if (next === null || next === room) continue;
    const door = doorByEdge.get(edgeKey(room, next));
    if (plan.required.has(door)) crossed.add(door);
    room = next;
  }
  const before = tracker.doors.size;
  for (const door of crossed) tracker.doors.add(door);
  tracker.room = room;
  return { valid: true, changed: tracker.doors.size !== before };
}

export function coverageProgress(tracker, plan) {
  return { doorIds: [...tracker.doors], completed: tracker.doors.size, total: plan.required.size, ready: tracker.doors.size === plan.required.size };
}
