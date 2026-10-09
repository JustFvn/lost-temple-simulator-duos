import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { ROTATION_PERIOD_MS, rotationState } from "./public/rotation.js";
const url = process.env.TEST_URL || "http://localhost:3000";
const sockets = Array.from({ length: 4 }, () => io(url, { forceNew: true })), host = sockets[0];
const once = (socket, event) => new Promise((resolve, reject) => {
  const done = value => { clearTimeout(timer); socket.off(event, done); resolve(value); };
  const timer = setTimeout(() => { socket.off(event, done); reject(new Error(`${event} 逾時`)); }, 7000); socket.on(event, done);
});
const ack = (socket, event, data = {}) => new Promise((resolve, reject) => socket.timeout(7000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function begin() {
  const starts = sockets.map(s => once(s, "round:start"));
  assert.equal((await ack(host, "round:start")).ok, true);
  const rounds = await Promise.all(starts); for (const round of rounds) assert.deepEqual(round, rounds[0]); return rounds[0];
}
async function win(round, score) {
  const fourth = sockets[3], ends = sockets.map(s => once(s, "round:end"));
  fourth.emit("player:state", { roundId: round.roundId, x: 410, y: 90, steps: 12 });
  assert.equal((await ack(fourth, "goal:reached", { roundId: round.roundId })).ok, true);
  for (const result of await Promise.all(ends)) { assert.equal(result.winner, 3); assert.equal(result.scores[3], score); assert.equal(result.matchWinner, score === 2 ? 3 : -1); }
}
try {
  await Promise.all(sockets.map(s => once(s, "connect")));
  const created = await ack(host, "room:create", { name: "旋轉房主" });
  for (const [i, socket] of sockets.slice(1).entries()) await ack(socket, "room:join", { code: created.room.code, name: `旋轉玩家 ${i + 2}` });
  let settings = { ...created.room.settings, doorMode: "rotate", layoutMode: "fixed", fixedLayout: 12, scoreToWin: 2 };
  assert.equal((await ack(sockets[1], "settings:update", settings)).ok, false);
  assert.equal((await ack(host, "settings:update", { ...settings, doorMode: "bad" })).ok, false);
  assert.equal((await ack(host, "settings:update", settings)).ok, true);
  let round = await begin(); assert.equal(round.layoutId, 12); assert.equal(round.rotation.periodMs, ROTATION_PERIOD_MS); assert.equal(round.traffic, null); assert.equal(round.coverageTotal, 0);
  assert.equal((await ack(host, "settings:update", settings)).ok, false);
  assert.equal((await ack(sockets[3], "goal:reached", { roundId: round.roundId })).ok, false, "倒數中不能得分");
  assert.equal(rotationState(round.rotation, 0).angle, 0);
  await wait(Math.max(0, round.startsAt - Date.now() + 40));
  const discovery = once(sockets[3], "door:discover"); host.emit("door:discover", { roundId: round.roundId, doorId: 18 }); assert.equal((await discovery).state, 1);
  await win(round, 1);
  settings = { ...settings, mapMode: "procedural", viewMode: "scroll" }; assert.equal((await ack(host, "settings:update", settings)).ok, true);
  const old = round; round = await begin(); assert.equal(round.layoutId, null); assert.equal(round.settings.viewMode, "scroll");
  assert.equal(round.rotation.periodMs, old.rotation.periodMs); assert.notEqual(round.roundId, old.roundId);
  await wait(Math.max(0, round.startsAt - Date.now() + 40));
  assert.equal((await ack(host, "goal:reached", { roundId: old.roundId })).ok, false);
  await win(round, 1); round = await begin(); await wait(Math.max(0, round.startsAt - Date.now() + 40)); await win(round, 2);
  assert.equal((await ack(host, "settings:update", { ...settings, doorMode: "normal" })).ok, true);
  round = await begin(); assert.equal(round.rotation, null, "其他模式不可殘留旋轉設定");
  await ack(host, "room:leave");
  console.log("OK: 四人旋轉模式同步、房主權限、官方／生成及捲軸搭配、倒數、共享探門、4P計分與整場勝利、回合重置及其他模式不旋轉。");
} finally { sockets.forEach(s => s.disconnect()); }
