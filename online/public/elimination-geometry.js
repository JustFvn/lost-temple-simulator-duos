import { BOARD, ROOM, WALL, DOOR, PR, START_I, GOAL_I, pos, buildWalls } from "./geometry.js";

export const CONNECTOR = 160;
export const STRIDE = BOARD + CONNECTOR;
export const stageOffset = stage => -stage * STRIDE;
export const stageAt = (y, finalStage) => Math.max(0, Math.min(finalStage, Math.floor((BOARD - y) / STRIDE)));
export const mapFor = (plan, stage, slot) => plan[stage].maps.find(map => map.slot === slot || map.slot === null);
export function roomAt(x, y, stage) {
  const localY = y - stageOffset(stage);
  const c = Math.floor((x - WALL) / (ROOM + WALL)), r = Math.floor((localY - WALL) / (ROOM + WALL));
  if (c < 0 || c > 4 || r < 0 || r > 4 || x > pos(c) + ROOM || localY > pos(r) + ROOM) return -1;
  return r * 5 + c;
}
export function trackWalls(plan, slot, qualified) {
  const result = [], left = (BOARD - DOOR) / 2, right = left + DOOR;
  plan.forEach((level, stage) => {
    const offset = stageOffset(stage), walls = buildWalls(new Set(mapFor(plan, stage, slot).openDoors));
    // Only the exits already earned are open; entering a new board is physical,
    // never a respawn or a change in world coordinates.
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[i];
      if ((i === 0 && stage < plan.length - 1 && stage <= qualified) || (i === 1 && stage > 0)) {
        result.push({ x: 0, y: wall.y + offset, w: left, h: WALL }, { x: right, y: wall.y + offset, w: BOARD - right, h: WALL });
      } else result.push({ ...wall, y: wall.y + offset });
    }
    if (stage < plan.length - 1) {
      result.push({ x: left - WALL, y: offset - CONNECTOR, w: WALL, h: CONNECTOR }, { x: right, y: offset - CONNECTOR, w: WALL, h: CONNECTOR });
    }
  });
  return result;
}
export function touchesWall(point, walls) {
  return walls.some(wall => Math.hypot(point.x - Math.max(wall.x, Math.min(point.x, wall.x + wall.w)), point.y - Math.max(wall.y, Math.min(point.y, wall.y + wall.h))) < PR - .05);
}
export function validSegment(from, to, walls) {
  const count = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
  for (let i = 1; i <= count; i++) if (touchesWall({ x: from.x + (to.x - from.x) * i / count, y: from.y + (to.y - from.y) * i / count }, walls)) return false;
  return true;
}
export { START_I, GOAL_I };
