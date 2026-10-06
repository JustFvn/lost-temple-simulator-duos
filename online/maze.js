import { DOORS } from "./public/layouts.js";
import { START_I, GOAL_I, allPaths } from "./public/geometry.js";

const EDGES = DOORS.map(([r1, c1, r2, c2], id) => ({ a: r1 * 5 + c1, b: r2 * 5 + c2, id }));
const ADJ = Array.from({ length: 25 }, () => []);
for (const { a, b, id } of EDGES) {
  ADJ[a].push({ next: b, id });
  ADJ[b].push({ next: a, id });
}

function shuffled(values, random) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function findPath(random, blocked = new Set()) {
  const visited = new Set([START_I]);
  const rooms = [START_I], doors = [];
  // A bounded randomized DFS prevents unlucky searches from holding up a room.
  let budget = 2000;
  function visit(room) {
    if (--budget < 0) return false;
    if (room === GOAL_I) return true;
    if (rooms.length >= 19) return false;
    for (const { next, id } of shuffled(ADJ[room], random)) {
      if (blocked.has(next) || visited.has(next)) continue;
      visited.add(next); rooms.push(next); doors.push(id);
      if (visit(next)) return true;
      visited.delete(next); rooms.pop(); doors.pop();
    }
    return false;
  }
  return visit(START_I) ? { rooms, doors } : null;
}

/** Generate one cycle containing start and goal, then attach optional dead ends.
 * Two internally disjoint paths form exactly two ways to the goal. Every extra
 * edge adds an unvisited room, so it can never introduce a third route.
 * This never samples the 125 official layouts.
 */
export function generateMaze(random = Math.random) {
  let pair;
  for (let attempt = 0; attempt < 80; attempt++) {
    const first = findPath(random);
    if (!first) continue;
    const second = findPath(random, new Set(first.rooms.slice(1, -1)));
    if (second) { pair = [first, second]; break; }
  }
  if (!pair) {
    // Both sides of the outer ring always respect the A3–B3 permanent wall.
    const routes = [[22, 21, 20, 15, 10, 5, 0, 1, 2], [22, 23, 24, 19, 14, 9, 4, 3, 2]];
    pair = routes.map(rooms => ({ rooms, doors: rooms.slice(1).map((room, i) =>
      EDGES.find(edge => (edge.a === rooms[i] && edge.b === room) || (edge.b === rooms[i] && edge.a === room)).id) }));
  }
  const open = new Set(pair.flatMap(path => path.doors));
  const used = new Set(pair.flatMap(path => path.rooms));
  // Preserve a mix of isolated rooms and dead-end branches for door discovery.
  const extraRooms = 2 + Math.floor(random() * 5);
  for (let i = 0; i < extraRooms; i++) {
    const candidates = EDGES.filter(edge => used.has(edge.a) !== used.has(edge.b));
    if (!candidates.length) break;
    const edge = shuffled(candidates, random)[0];
    open.add(edge.id); used.add(edge.a); used.add(edge.b);
  }
  const paths = allPaths(open);
  if (paths.length !== 2) throw new Error("生成迷宮必須恰有兩條通往終點的路線");
  return { openDoors: [...open].sort((a, b) => a - b), routeLengths: paths.map(path => path.length - 1) };
}
