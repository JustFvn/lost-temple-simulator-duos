import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { allPaths, roomCX, roomCY } from "./public/geometry.js";
import { coveragePlan } from "./public/route-coverage.js";
const url = process.env.TEST_URL || "http://localhost:3000";
const sockets = Array.from({ length: 4 }, () => io(url, { forceNew: true })), host = sockets[0];
const progress = sockets.map(() => null);
sockets.forEach((socket, i) => socket.on("route:progress", data => { progress[i] = data; }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const once = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off(event, done); reject(new Error(`${event} 逾時`)); }, 7000);
  const done = data => { clearTimeout(timer); socket.off(event, done); resolve(data); }; socket.on(event, done);
});
const ack = (socket, event, data = {}) => new Promise((resolve, reject) => socket.timeout(7000).emit(event, data, (error, value) => error ? reject(error) : resolve(value)));
const flush = socket => ack(socket, "clock:sync");
async function begin() {
  const starts = sockets.map(s => once(s, "round:start"));
  assert.equal((await ack(host, "round:start")).ok, true);
  const rounds = await Promise.all(starts); for (const round of rounds) assert.deepEqual(round, rounds[0]);
  return rounds[0];
}
async function walk(socket, round, rooms) {
  for (const [i, room] of rooms.entries()) socket.emit("player:state", { roundId: round.roundId, x: roomCX(room), y: roomCY(room), steps: i, revision: 0, coverageReady: true });
  await flush(socket);
}
try {
  await Promise.all(sockets.map(s => once(s, "connect")));
  const created = await ack(host, "room:create", { name: "探索房主" });
  for (const [i, socket] of sockets.slice(1).entries()) assert.equal((await ack(socket, "room:join", { code: created.room.code, name: `探索者 ${i + 2}` })).ok, true);
  const settings = { ...created.room.settings, doorMode: "coverage", layoutMode: "fixed", fixedLayout: 12, scoreToWin: 2, viewMode: "scroll" };
  assert.equal((await ack(host, "settings:update", { ...settings, mapMode: "procedural" })).ok, false, "伺服器限制官方佈局");
  assert.equal((await ack(sockets[1], "settings:update", settings)).ok, false);
  assert.equal((await ack(host, "settings:update", settings)).ok, true);
  let round = await begin(); assert.equal(round.layoutId, 12);
  assert.equal(round.coverageTotal, coveragePlan(new Set(round.openDoors)).required.size);
  const paths = allPaths(new Set(round.openDoors));
  await walk(host, round, paths[0]); assert.equal(progress[0], null, "倒數中不計進度");
  assert.equal((await ack(host, "goal:reached", { roundId: round.roundId, revision: 0 })).ok, false);
  await wait(Math.max(0, round.startsAt - Date.now() + 40));
  const reset = once(host, "player:reset");
  host.emit("player:state", { roundId: round.roundId, x: 410, y: 90, steps: 99, revision: 0, coverageReady: true });
  assert.equal((await reset).revision, 1, "穿牆瞬移拒絕"); assert.equal(progress[0], null);
  // Reset revision only affects this participant, not the other three.
  for (const [index, socket] of sockets.slice(1).entries()) {
    await walk(socket, round, paths[0]); assert(progress[index + 1].completed > 0); assert(!progress[index + 1].ready);
    const result = await ack(socket, "goal:reached", { roundId: round.roundId, revision: 0 });
    assert.equal(result.ok, false); assert.match(result.error, /王冠尚未解鎖/);
  }
  assert.equal(progress[0], null, "別人走完一條路仍不增加房主進度");
  const fourth = sockets[3], shared = once(host, "door:discover");
  fourth.emit("door:discover", { roundId: round.roundId, doorId: 18 });
  assert.equal((await shared).state, 1); assert.equal(progress[0], null, "共享情報不增加進度");
  await walk(fourth, round, [...paths[1]].reverse()); assert(progress[3].ready);
  const otherCount = progress[1].completed; assert(!progress[1].ready);
  assert.equal((await ack(fourth, "goal:reached", { roundId: round.roundId, revision: 0 })).ok, false, "走完後仍要回 E3");
  await walk(fourth, round, paths[0]);
  const ends = sockets.map(s => once(s, "round:end"));
  assert.equal((await ack(fourth, "goal:reached", { roundId: round.roundId, revision: 0 })).ok, true);
  for (const result of await Promise.all(ends)) { assert.equal(result.winner, 3); assert.deepEqual(result.scores, [0, 0, 0, 1]); }
  assert.equal(progress[1].completed, otherCount);
  const oldRound = round; round = await begin(); assert.equal(round.coverageTotal, oldRound.coverageTotal);
  await wait(Math.max(0, round.startsAt - Date.now() + 40));
  await walk(fourth, oldRound, [...paths[1]].reverse());
  await walk(fourth, round, paths[0]); assert(!progress[3].ready, "新回合進度重置；舊回合封包無效");
  assert.equal((await ack(fourth, "goal:reached", { roundId: round.roundId, revision: 0 })).ok, false);
  await walk(fourth, round, [...paths[1]].reverse()); await walk(fourth, round, paths[0]);
  const final = once(host, "round:end");
  assert.equal((await ack(fourth, "goal:reached", { roundId: round.roundId, revision: 0 })).ok, true);
  assert.equal((await final).matchWinner, 3);
  assert.equal((await ack(host, "settings:update", { ...settings, doorMode: "normal", mapMode: "procedural" })).ok, true, "切回其他玩法可用生成迷宮");
  console.log("OK: 四人官方限定、倒數、穿牆拒絕、自報完成無效、獨立探索／共享情報、未完成終點拒絕、4P 得分與整場勝利、新回合重置與舊封包拒絕。");
} finally { sockets.forEach(s => s.disconnect()); }
