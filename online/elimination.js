import { randomInt } from "node:crypto";
import { LAYOUTS } from "./public/layouts.js";
import { BOARD, PR, SPEED, GAPS, allPaths } from "./public/geometry.js";
import { spawnPosition } from "./public/players.js";
import { generateMaze } from "./maze.js";
import { stageAt, stageOffset, trackWalls, validSegment, roomAt, START_I, GOAL_I } from "./public/elimination-geometry.js";

export function createElimination(slots, settings, now) {
  const used = new Set(), plan = [], official = LAYOUTS.map(([, doors]) => [...doors]);
  function uniqueMap(slot) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (settings.mapMode === "official" && !official.length) break;
      const doors = settings.mapMode === "official" ? official.splice(randomInt(official.length), 1)[0] : generateMaze().openDoors;
      const paths = allPaths(new Set(doors));
      // Compare actual start-to-goal routes, not unused doors off those routes.
      const signature = paths.map(path => path.join(",")).sort().join("|");
      if (used.has(signature)) continue;
      used.add(signature);
      return { slot, openDoors: [...doors], routeLengths: paths.map(path => path.length - 1) };
    }
    throw new Error("無法產生足夠的不重複路線，請重新開始。");
  }
  const finalStage = slots.length - 2;
  for (let stage = 0; stage <= finalStage; stage++) plan.push({ final: stage === finalStage, quota: stage === finalStage ? 1 : slots.length - stage - 1, maps: stage === finalStage ? [uniqueMap(null)] : slots.map(uniqueMap) });
  const players = new Map(slots.map(slot => [slot, {
    slot, ...spawnPosition(slot), steps: 0, stage: 0, qualified: -1, eliminated: false, eliminatedAt: null, rank: null, finished: false,
    known: plan.map(() => new Set()), visited: plan.map(() => new Set([START_I])), lastRoom: `0:${START_I}`, lastMove: now,
    walls: trackWalls(plan, slot, -1),
  }]));
  return { plan, players, arrivals: plan.map(() => []), finalStage, resolved: 0, winner: null, champion: null };
}
export function eliminationState(race) {
  return {
    resolved: race.resolved, finalStage: race.finalStage, champion: race.champion,
    stages: race.plan.map((level, stage) => ({ quota: level.quota, arrived: race.arrivals[stage].slice(), final: level.final })),
    players: [...race.players.values()].map(({ slot, x, y, stage, qualified, steps, eliminated, eliminatedAt, rank, finished, known, visited }) => ({ slot, x, y, stage, qualified, steps, eliminated, eliminatedAt, rank, finished, known: known.map(ids => [...ids]), visited: visited.map(ids => [...ids]) })),
  };
}
export function moveElimination(race, slot, data, now) {
  const player = race.players.get(slot);
  if (!player || player.eliminated || player.finished) return { ignored: true };
  const x = data?.x, y = data?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < PR || x > BOARD - PR || y > BOARD - PR || y < stageOffset(race.finalStage) + PR) return { correction: true };
  const distance = Math.hypot(x - player.x, y - player.y);
  // Limit catch-up jumps as well as sampling collisions along every segment.
  const elapsed = Math.min(1000, Math.max(0, now - player.lastMove));
  if (distance > SPEED * elapsed / 1000 * 1.3 + 12 || !validSegment(player, { x, y }, player.walls)) return { correction: true };
  player.lastMove = now; player.x = x; player.y = y;
  player.stage = stageAt(y, race.finalStage);
  const index = roomAt(x, y, player.stage);
  if (index !== -1) {
    player.visited[player.stage].add(index);
    const key = `${player.stage}:${index}`;
    if (key !== player.lastRoom) { player.steps++; player.lastRoom = key; }
  }
  const localY = y - stageOffset(player.stage);
  GAPS.forEach((gap, id) => {
    if (Math.hypot(x - Math.max(gap.x, Math.min(x, gap.x + gap.w)), localY - Math.max(gap.y, Math.min(localY, gap.y + gap.h))) < PR + 3) player.known[player.stage].add(id);
  });
  if (index === GOAL_I && player.stage === player.qualified + 1) {
    player.qualified = player.stage;
    race.arrivals[player.stage].push(slot);
    if (player.stage === race.finalStage) {
      player.finished = true;
      if (race.champion === null) race.champion = slot;
    }
    player.walls = trackWalls(race.plan, slot, player.qualified);
  }
  // Resolve in order even when leaders are already racing in later boards.
  while (race.resolved < race.finalStage && race.arrivals[race.resolved].length >= race.plan[race.resolved].quota) {
    const stage = race.resolved;
    for (const racer of race.players.values()) {
      if (!racer.eliminated && !race.arrivals[stage].includes(racer.slot)) {
        racer.eliminated = true; racer.eliminatedAt = stage; racer.rank = race.players.size - stage;
      }
    }
    race.resolved++;
  }
  if (race.resolved === race.finalStage && race.champion !== null && race.winner === null) {
    race.winner = race.champion;
    for (const racer of race.players.values()) if (!racer.eliminated) {
      racer.rank = racer.slot === race.winner ? 1 : 2;
      if (racer.slot !== race.winner) { racer.eliminated = true; racer.eliminatedAt = race.finalStage; }
    }
  }
  return { winner: race.winner };
}
