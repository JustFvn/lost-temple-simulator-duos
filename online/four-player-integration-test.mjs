import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { spawnPosition } from "./public/players.js";
import { GAPS } from "./public/geometry.js";
import { trafficState } from "./public/traffic.js";
const url = process.env.TEST_URL || "http://localhost:3000";
const sockets = Array.from({ length: 5 }, () => io(url, { forceNew: true }));
const [host, second, third, fourth, fifth] = sockets;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const once = (socket, event, accept = () => true) => new Promise((resolve, reject) => {
  const handler = value => { if (!accept(value)) return; socket.off(event, handler); clearTimeout(timer); resolve(value); };
  const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`等待 ${event} 逾時`)); }, 12000);
  socket.on(event, handler);
});
const ack = (socket, event, data = {}) => new Promise((resolve, reject) => socket.timeout(7000).emit(event, data, (error, value) => error ? reject(error) : resolve(value)));
const solve = question => {
  const [, a, op, b] = question.match(/^(\d+) ([+−×÷]) (\d+) = \?$/);
  return op === "+" ? +a + +b : op === "−" ? +a - +b : op === "×" ? +a * +b : +a / +b;
};
async function begin(participants) {
  const starts = participants.map(socket => once(socket, "round:start"));
  assert.equal((await ack(host, "round:start")).ok, true);
  const rounds = await Promise.all(starts); for (const round of rounds) assert.deepEqual(round, rounds[0]);
  assert.equal(rounds[0].players.length, participants.length);
  for (const player of rounds[0].players) assert.deepEqual({ x: player.x, y: player.y }, spawnPosition(player.slot));
  await wait(Math.max(0, rounds[0].startsAt - Date.now() + 30)); return rounds[0];
}
async function win(socket, round, participants, slot, score, matchWinner) {
  const ends = participants.map(socket => once(socket, "round:end"));
  socket.emit("player:state", { roundId: round.roundId, x: 410, y: 90, steps: 12, revision: 0 });
  assert.equal((await ack(socket, "goal:reached", { roundId: round.roundId, revision: 0 })).ok, true);
  const results = await Promise.all(ends); for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(results[0].winner, slot); assert.equal(results[0].scores[slot], score); assert.equal(results[0].matchWinner, matchWinner);
  assert.equal(results[0].players.length, participants.length);
  assert.equal((await ack(socket, "goal:reached", { roundId: round.roundId, revision: 0 })).ok, false);
}
try {
  await Promise.all(sockets.map(socket => once(socket, "connect")));
  const created = await ack(host, "room:create", { name: "四人房主" }), code = created.room.code;
  assert.equal(created.room.maxPlayers, 4); assert.equal((await ack(host, "round:start")).ok, false);
  for (const [index, socket] of [second, third].entries()) assert.equal((await ack(socket, "room:join", { code, name: `玩家 ${index + 2}` })).slot, index + 1);
  let settings = { ...created.room.settings, layoutMode: "fixed", fixedLayout: 12, scoreToWin: 2 };
  await ack(host, "settings:update", settings);
  let round = await begin([host, second, third]);
  assert.equal((await ack(fourth, "room:join", { code, name: "第四位" })).ok, false, "回合中不可中途加入");
  await win(third, round, [host, second, third], 2, 1, -1);
  const joined = await ack(fourth, "room:join", { code, name: "第四位" });
  assert.equal(joined.slot, 3); assert.deepEqual(joined.room.scores, [0, 0, 0, 0], "新玩家加入重開比分");
  assert.equal((await ack(fifth, "room:join", { code, name: "第五位" })).ok, false, "最多四人");
  for (const socket of [second, third, fourth]) {
    assert.equal((await ack(socket, "settings:update", settings)).ok, false);
    assert.equal((await ack(socket, "round:start")).ok, false);
  }
  settings = { ...settings, doorMode: "math", viewMode: "scroll" }; await ack(host, "settings:update", settings);
  const four = [host, second, third, fourth]; round = await begin(four);
  const gap = GAPS[18], questions = [];
  for (const socket of four) {
    socket.emit("player:state", { roundId: round.roundId, x: gap.x - 10, y: 730, steps: 0 });
    questions.push((await ack(socket, "door:challenge", { roundId: round.roundId, doorId: 18 })).challenge);
  }
  assert.equal(new Set(questions.map(question => question.id)).size, 4, "四人的題目 ID 各自獨立");
  const discoveries = four.map(socket => once(socket, "door:discover"));
  await ack(host, "door:answer", { roundId: round.roundId, challengeId: questions[0].id, answer: solve(questions[0].question) });
  for (const discovery of await Promise.all(discoveries)) { assert.equal(discovery.doorId, 18); assert.equal(discovery.state, 1); }
  for (let index = 1; index < 4; index++) {
    const socket = four[index], question = questions[index];
    assert.equal((await ack(socket, "door:challenge", { roundId: round.roundId, doorId: 18 })).challenge.id, question.id);
    assert.equal((await ack(socket, "door:answer", { roundId: round.roundId, challengeId: questions[0].id, answer: 0 })).ok, false);
    socket.emit("player:state", { roundId: round.roundId, x: 410, y: 90, steps: 12 });
    assert.equal((await ack(socket, "goal:reached", { roundId: round.roundId })).ok, false);
    assert.equal((await ack(socket, "door:answer", { roundId: round.roundId, challengeId: question.id, answer: solve(question.question) })).correct, true);
  }
  await win(fourth, round, four, 3, 1, -1);
  round = await begin(four); await win(fourth, round, four, 3, 2, 3);
  settings = { ...settings, doorMode: "traffic" }; await ack(host, "settings:update", settings); round = await begin(four);
  let signal;
  for (let i = 0; i < 250; i++) {
    signal = trafficState(round.traffic, Date.now() - round.startsAt);
    if (signal.phase === "red" && signal.phaseElapsed > 300 && signal.remaining > 600) break;
    await wait(30);
  }
  assert.equal(signal.phase, "red");
  for (const [slot, socket] of [[2, third], [3, fourth]]) {
    const resets = four.map(socket => once(socket, "player:reset", data => data.slot === slot));
    socket.emit("player:state", { roundId: round.roundId, ...spawnPosition(slot), steps: 0, revision: 0, moving: true, trafficIndex: signal.index });
    for (const reset of await Promise.all(resets)) { assert.equal(reset.slot, slot); assert.equal(reset.revision, 1); assert.deepEqual({ x: reset.x, y: reset.y }, spawnPosition(slot)); }
  }
  const departed = once(host, "room:state", room => room.players.length === 3);
  await ack(third, "room:leave"); const afterLeave = await departed;
  assert.deepEqual(afterLeave.players.map(player => player.slot), [0, 1, 3]); assert.deepEqual(afterLeave.scores, [0, 0, 0, 0]);
  assert.equal(afterLeave.status, "lobby");
  await ack(host, "settings:update", { ...settings, doorMode: "normal", scoreToWin: 1 });
  round = await begin([host, second, fourth]); assert.deepEqual(round.players.map(player => player.slot), [0, 1, 3]);
  await win(fourth, round, [host, second, fourth], 3, 1, 3);
  assert.equal((await ack(third, "room:join", { code, name: "補空席" })).slot, 2);
  const closed = [second, third, fourth].map(socket => once(socket, "room:closed"));
  await ack(host, "room:leave"); await Promise.all(closed);
  for (const socket of [second, third, fourth]) assert.equal((await ack(socket, "room:create", { name: "新房主" })).ok, true);
  console.log("OK: 三／四人開局、第五人拒絕、四端同步、3P／4P計分勝利、四人獨立答題與共享、紅燈各自回起點、空席補位與全房關閉。");
} finally { for (const socket of sockets) socket.disconnect(); }
