import assert from "node:assert/strict";
import { io } from "socket.io-client";

const url = process.env.TEST_URL || "http://localhost:3000";
const host = io(url, { forceNew: true });
const guest = io(url, { forceNew: true });

const once = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`等待 ${event} 逾時`)), 3000);
  socket.once(event, value => { clearTimeout(timer); resolve(value); });
});
const emitAck = (socket, event, data) => new Promise(resolve => socket.emit(event, data, resolve));

try {
  const page = await fetch(url).then(response => response.text());
  assert.match(page, /迷途神廟線上對戰/);
  await Promise.all([once(host, "connect"), once(guest, "connect")]);

  const created = await emitAck(host, "room:create", { name: "房主" });
  assert.equal(created.ok, true);
  assert.match(created.room.code, /^[A-Z2-9]{6}$/);

  const joined = await emitAck(guest, "room:join", { code: created.room.code, name: "訪客" });
  assert.equal(joined.ok, true);
  assert.equal(joined.slot, 1);

  const denied = await emitAck(guest, "settings:update", { scoreToWin: 7 });
  assert.equal(denied.ok, false, "訪客不應能修改房主設定");

  const nextState = once(guest, "room:state");
  const changed = await emitAck(host, "settings:update", {
    drawMode: "uniform",
    layoutMode: "fixed",
    fixedLayout: 12,
    scoreToWin: 5,
    shareDiscovery: false,
    revealAfterRound: false,
  });
  assert.equal(changed.ok, true);
  const state = await nextState;
  assert.equal(state.settings.fixedLayout, 12);
  assert.equal(state.settings.scoreToWin, 5);

  const hostStart = once(host, "round:start");
  const guestStart = once(guest, "round:start");
  const started = await emitAck(host, "round:start", null);
  assert.equal(started.ok, true);
  const [hostRound, guestRound] = await Promise.all([hostStart, guestStart]);
  assert.equal(hostRound.layoutId, 12);
  assert.equal(guestRound.layoutId, 12);

  const hostEnd = once(host, "round:end");
  const guestEnd = once(guest, "round:end");
  host.emit("player:state", { x: 410, y: 90, steps: 8 });
  host.emit("goal:reached");
  const [hostResult, guestResult] = await Promise.all([hostEnd, guestEnd]);
  assert.equal(hostResult.winner, 0);
  assert.deepEqual(guestResult.scores, [1, 0]);

  console.log("OK: 建房、加入、房主設定、訪客越權阻擋、指定佈局開局與勝負同步。配置正確。");
} finally {
  host.disconnect();
  guest.disconnect();
}
