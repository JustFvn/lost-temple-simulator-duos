import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { allPaths } from "./public/geometry.js";

const url = process.env.TEST_URL || "http://localhost:3000";
const host = io(url, { forceNew: true }), guest = io(url, { forceNew: true });
const once = (socket, event, accept = () => true) => new Promise((resolve, reject) => {
  const handler = value => { if (!accept(value)) return; socket.off(event, handler); clearTimeout(timer); resolve(value); };
  const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`等待 ${event} 逾時`)); }, 7000);
  socket.on(event, handler);
});
const ack = (socket, event, data = {}) => new Promise((resolve, reject) => socket.timeout(7000).emit(event, data, (error, value) => error ? reject(error) : resolve(value)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function begin() {
  const both = [once(host, "round:start"), once(guest, "round:start")];
  assert.equal((await ack(host, "round:start")).ok, true);
  const [a, b] = await Promise.all(both);
  assert.deepEqual(a, b, "兩端必須拿到相同生成迷宮及時間");
  return a;
}
async function win(round, expectedScore) {
  await wait(Math.max(0, round.startsAt - Date.now() + 30));
  const both = [once(host, "round:end"), once(guest, "round:end")];
  host.emit("player:state", { roundId: round.roundId, x: 410, y: 90, steps: 8 });
  assert.equal((await ack(host, "goal:reached", { roundId: round.roundId })).ok, true);
  const [a, b] = await Promise.all(both);
  assert.deepEqual(a, b); assert.deepEqual(a.scores, [expectedScore, 0]);
  assert.equal(a.winner, 0); assert.equal(a.steps, 8); assert(a.elapsedMs >= 0);
  return a;
}
try {
  const page = await fetch(`${url}/?room=ABC234`).then(r => r.text());
  assert.match(page, /迷途神廟線上對戰/); assert.match(page, /自訂勝利分數/);
  await Promise.all([once(host, "connect"), once(guest, "connect")]);
  const created = await ack(host, "room:create", { name: "房主" });
  assert.equal(created.ok, true); assert.match(created.room.code, /^[A-Z2-9]{6}$/);
  const joined = await ack(guest, "room:join", { code: created.room.code, name: "取好名字的朋友" });
  assert.equal(joined.ok, true); assert.equal(joined.room.players[1].name, "取好名字的朋友");
  assert.equal((await ack(guest, "settings:update", { scoreToWin: 7 })).ok, false);
  assert.equal((await ack(guest, "round:start")).ok, false);
  const settings = { ...created.room.settings, layoutMode: "fixed", fixedLayout: 12, scoreToWin: 2, shareDiscovery: false, revealAfterRound: false };
  assert.equal(settings.viewMode, "standard");
  assert.equal((await ack(host, "settings:update", { ...settings, viewMode: "invalid" })).ok, false);
  for (const value of [0, -1, 1.5, 100, "abc"]) assert.equal((await ack(host, "settings:update", { ...settings, scoreToWin: value })).ok, false);
  assert.equal((await ack(host, "settings:update", settings)).ok, true);
  const official = await begin(); assert.equal(official.layoutId, 12);
  assert.equal(official.countdownMs, 3500);
  host.emit("player:state", { roundId: official.roundId, x: 410, y: 90, steps: 8 });
  assert.equal((await ack(host, "goal:reached", { roundId: official.roundId })).ok, false, "倒數中不可獲勝");
  await wait(Math.max(0, official.startsAt - Date.now() + 30));
  assert.equal((await ack(host, "goal:reached", { roundId: official.roundId })).ok, false, "倒數中的位置必須被拒絕");
  const first = await win(official, 1); assert.equal(first.matchWinner, -1); assert.equal(first.routeLengths, null);
  assert.equal((await ack(host, "goal:reached", { roundId: official.roundId })).ok, false, "勝利不可重複計分");
  const next = await begin();
  await wait(Math.max(0, next.startsAt - Date.now() + 30));
  host.emit("player:state", { roundId: official.roundId, x: 410, y: 90, steps: 100 });
  assert.equal((await ack(host, "goal:reached", { roundId: next.roundId })).ok, false, "舊回合位置不可用於新回合");
  const final = await win(next, 2); assert.equal(final.matchWinner, 0, "自訂兩分觸發整場勝利");
  const statePromise = once(guest, "room:state", value => value.settings.mapMode === "procedural");
  assert.equal((await ack(host, "settings:update", { ...settings, mapMode: "procedural", viewMode: "fog", scoreToWin: 4, shareDiscovery: true, revealAfterRound: true })).ok, true);
  const state = await statePromise; assert.deepEqual(state.scores, [0, 0]); assert.equal(state.settings.scoreToWin, 4);
  const generated = await begin(); assert.equal(generated.layoutId, null);
  assert.equal(generated.settings.viewMode, "fog", "兩端必須同步黑霧模式");
  const generatedPaths = allPaths(new Set(generated.openDoors));
  assert.equal(generatedPaths.length, 2);
  assert.equal(generated.openDoors.length, generatedPaths.reduce((sum, path) => sum + path.length - 1, 0), "伺服器生成地圖不可包含死路支線");
  assert.equal((await ack(host, "settings:update", settings)).ok, false, "回合中不可修改規則");
  const result = await win(generated, 1); assert.equal(result.routeLengths.length, 2);
  const restart = await begin(); assert.equal(restart.roundNumber, 2);
  const departed = once(host, "room:state", value => value.players.length === 1);
  assert.equal((await ack(guest, "room:leave")).ok, true);
  const afterLeave = await departed; assert.equal(afterLeave.status, "lobby"); assert.deepEqual(afterLeave.scores, [0, 0]);
  assert.equal((await ack(guest, "room:join", { code: created.room.code, name: "重新加入" })).ok, true);
  const closed = once(guest, "room:closed");
  await ack(host, "room:leave"); await closed;
  assert.equal((await ack(guest, "room:create", { name: "新房主" })).ok, true, "房間關閉後可建立新房間");
  console.log("OK: 雙人取名、房主權限、自訂分數、同步倒數、官方/生成模式、整場勝利、舊回合隔離與離房重建。");
} finally { host.disconnect(); guest.disconnect(); }
