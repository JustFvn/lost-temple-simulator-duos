import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, randomInt } from "node:crypto";
import { extname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { LAYOUTS } from "./public/layouts.js";
import { allPaths, GAPS, PR, START_I, GOAL_I, ROOM, pos } from "./public/geometry.js";
import { generateMaze } from "./maze.js";
import { generateMathProblem, isCorrectAnswer } from "./math-challenge.js";
import { createTrafficSchedule, trafficState, TRAFFIC_GRACE_MS } from "./public/traffic.js";
import { MAX_PLAYERS, emptyScores, spawnPosition, availableSlot, balancedTeam } from "./public/players.js";
import { coveragePlan, createCoverage, advanceCoverage, coverageProgress } from "./public/route-coverage.js";
import { ROTATION_PERIOD_MS } from "./public/rotation.js";
import { createElimination, eliminationState, moveElimination } from "./elimination.js";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = join(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)));
    const rel = relative(ROOT, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid path");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});
const io = new Server(httpServer, { serveClient: true });
const rooms = new Map();
const DEFAULT_SETTINGS = { mapMode: "official", viewMode: "standard", doorMode: "normal", teamMode: false, drawMode: "weighted", layoutMode: "random", fixedLayout: 0, scoreToWin: 3, shareDiscovery: true, revealAfterRound: true };
const reply = (ack, payload) => { if (typeof ack === "function") ack(payload); };
const fail = (ack, error) => reply(ack, { ok: false, error });
const findRoom = socket => rooms.get(socket.data.roomCode);
const cleanName = (name, fallback) => String(name || "").trim().slice(0, 16) || fallback;
function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join(""); } while (rooms.has(code));
  return code;
}
function cleanSettings(value = {}) {
  const scoreToWin = Number(value.scoreToWin);
  const fixedLayout = Number(value.fixedLayout);
  if (!Number.isInteger(scoreToWin) || scoreToWin < 1 || scoreToWin > 99) throw new Error("勝利分數必須是 1–99 的整數。");
  if (!Number.isInteger(fixedLayout) || fixedLayout < 0 || fixedLayout >= LAYOUTS.length) throw new Error("佈局編號必須是 0–124 的整數。");
  if (!["official", "procedural"].includes(value.mapMode)) throw new Error("無效的迷宮模式。");
  // Accept the old wire value from cached clients, but never enable fog again.
  const viewMode = value.viewMode === "fog" ? "scroll" : value.viewMode ?? "standard";
  if (!["standard", "scroll"].includes(viewMode)) throw new Error("無效的鏡頭模式。");
  const doorMode = value.doorMode ?? "normal";
  if (!["normal", "math", "traffic", "coverage", "rotate", "reverse", "elimination"].includes(doorMode)) throw new Error("無效的遊戲玩法。");
  if (doorMode === "coverage" && value.mapMode !== "official") throw new Error("全路線探索只能使用官方佈局。");
  if (doorMode === "reverse" && value.mapMode !== "official") throw new Error("逆向神廟只能使用官方佈局。");
  const elimination = doorMode === "elimination";
  return { mapMode: value.mapMode, viewMode, doorMode, teamMode: !elimination && value.teamMode === true, drawMode: value.drawMode === "uniform" ? "uniform" : "weighted", layoutMode: elimination ? "random" : value.layoutMode === "fixed" ? "fixed" : "random", fixedLayout, scoreToWin: elimination ? 1 : scoreToWin, shareDiscovery: !elimination && value.shareDiscovery !== false, revealAfterRound: value.revealAfterRound !== false };
}
function publicRoom(room) {
  return { code: room.code, hostId: room.hostId, maxPlayers: MAX_PLAYERS, settings: room.settings, status: room.status, scores: room.scores, teamScores: room.teamScores, roundNumber: room.roundNumber, players: [...room.players].map(([id, player]) => ({ id, slot: player.slot, name: player.name, team: player.team })) };
}
const broadcast = room => io.to(room.code).emit("room:state", publicRoom(room));
function resetMatch(room) {
  room.status = "lobby"; room.scores = emptyScores(); room.teamScores = [0, 0]; room.roundNumber = 0; room.roundId = null; room.race = null;
}
function shareDoor(room, socket, payload, includeSelf = false) {
  const sender = room.players.get(socket.id);
  for (const [id, player] of room.players) {
    if (!includeSelf && id === socket.id) continue;
    if (room.settings.teamMode && player.team !== sender.team) continue;
    io.to(id).emit("door:discover", payload);
  }
}
function pickLayout(settings) {
  if (settings.layoutMode === "fixed") return settings.fixedLayout;
  if (settings.drawMode === "uniform") return randomInt(LAYOUTS.length);
  let roll = Math.random() * LAYOUTS.reduce((sum, layout) => sum + layout[0], 0);
  for (let i = 0; i < LAYOUTS.length; i++) { roll -= LAYOUTS[i][0]; if (roll <= 0) return i; }
  return LAYOUTS.length - 1;
}
function leave(socket) {
  const room = findRoom(socket);
  socket.data.roomCode = null;
  if (!room) return;
  const leavingPlayer = room.players.get(socket.id);
  const eliminatedSpectator = room.status === "playing" && room.race?.players.get(leavingPlayer?.slot)?.eliminated;
  socket.leave(room.code);
  room.players.delete(socket.id);
  if (room.hostId === socket.id) {
    io.to(room.code).emit("room:closed", "房主已離開，房間已關閉。");
    for (const id of room.players.keys()) {
      const guest = io.sockets.sockets.get(id);
      if (guest) { guest.data.roomCode = null; guest.leave(room.code); }
    }
    rooms.delete(room.code);
  } else {
    // Eliminated spectators can leave without cancelling the remaining race.
    if (!eliminatedSpectator) resetMatch(room);
    broadcast(room);
  }
}
function activeRound(socket, data) {
  const room = findRoom(socket);
  return room?.status === "playing" && room.roundId === data?.roundId && Date.now() >= room.startsAt ? room : null;
}
io.on("connection", socket => {
  socket.on("clock:sync", (_, ack) => reply(ack, { serverNow: Date.now() }));
  socket.on("room:create", (data, ack) => {
    if (findRoom(socket)) return fail(ack, "你已經在房間內。");
    const code = roomCode();
    const room = { code, hostId: socket.id, settings: { ...DEFAULT_SETTINGS }, status: "lobby", scores: emptyScores(), teamScores: [0, 0], roundNumber: 0, roundId: null, players: new Map([[socket.id, { slot: 0, team: 0, name: cleanName(data?.name, "主辦者") }]]) };
    rooms.set(code, room); socket.data.roomCode = code; socket.join(code);
    reply(ack, { ok: true, slot: 0, room: publicRoom(room) }); broadcast(room);
  });
  socket.on("room:join", (data, ack) => {
    if (findRoom(socket)) return fail(ack, "你已經在房間內。");
    const room = rooms.get(String(data?.code || "").trim().toUpperCase());
    if (!room) return fail(ack, "找不到房間，請確認房號或請房主重新建立。");
    if (room.players.size >= MAX_PLAYERS) return fail(ack, "房間已滿（最多 4 人）。");
    if (room.status === "playing") return fail(ack, "對戰已開始。");
    const slot = availableSlot(room.players.values());
    room.players.set(socket.id, { slot, team: balancedTeam(room.players.values()), name: cleanName(data?.name, `挑戰者 ${slot + 1}`) });
    // A new participant starts a fresh match; never inherit a vacated score.
    resetMatch(room);
    socket.data.roomCode = room.code; socket.join(room.code);
    reply(ack, { ok: true, slot, room: publicRoom(room) }); broadcast(room);
  });
  socket.on("room:leave", (_, ack) => { leave(socket); reply(ack, { ok: true }); });
  socket.on("team:choose", (data, ack) => {
    const room = findRoom(socket);
    if (!room?.settings.teamMode) return fail(ack, "尚未啟用兩隊對戰。");
    if (room.status === "playing") return fail(ack, "回合中不能換隊。");
    const id = data?.playerId ?? socket.id, player = room.players.get(id);
    if (!player || (id !== socket.id && room.hostId !== socket.id)) return fail(ack, "只能選擇自己的隊伍；房主可以調整所有玩家。");
    if (data?.team !== 0 && data?.team !== 1) return fail(ack, "無效的隊伍。");
    if (player.team !== data.team) { player.team = data.team; resetMatch(room); }
    broadcast(room); reply(ack, { ok: true });
  });
  socket.on("settings:update", (data, ack) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return fail(ack, "只有房主可以調整設定。");
    if (room.status === "playing") return fail(ack, "回合中不能修改設定。");
    try {
      const settings = cleanSettings(data);
      if (JSON.stringify(settings) !== JSON.stringify(room.settings)) {
        room.settings = settings; resetMatch(room);
      }
      broadcast(room); reply(ack, { ok: true });
    } catch (error) { fail(ack, error.message); }
  });
  socket.on("round:start", (_, ack) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return fail(ack, "只有房主可以開始回合。");
    if (room.players.size < 2) return fail(ack, "至少需要兩位玩家，最多四人。");
    if (room.status === "playing") return fail(ack, "回合已經開始。");
    if (room.settings.doorMode === "elimination") {
      let race;
      try { race = createElimination([...room.players.values()].map(player => player.slot), room.settings, 0); }
      catch (error) { return fail(ack, error.message); }
      const startsAt = Date.now() + 3500;
      for (const racer of race.players.values()) racer.lastMove = startsAt;
      room.scores = emptyScores(); room.teamScores = [0, 0]; room.roundNumber++;
      room.race = race; room.roundId = randomUUID(); room.status = "playing"; room.startsAt = startsAt;
      room.traffic = room.coverage = room.rotation = null;
      room.startI = START_I; room.goalI = GOAL_I;
      io.to(room.code).emit("round:start", { roundId: room.roundId, roundNumber: room.roundNumber, openDoors: race.plan[0].maps[0].openDoors, settings: room.settings, startI: START_I, goalI: GOAL_I, scores: room.scores, teamScores: room.teamScores, startsAt, serverNow: Date.now(), players: eliminationState(race).players, elimination: { plan: race.plan, ...eliminationState(race) } });
      broadcast(room); return reply(ack, { ok: true });
    }
    if (room.settings.teamMode && ![0, 1].every(team => [...room.players.values()].some(player => player.team === team))) return fail(ack, "藍隊與紅隊都需要至少一位玩家才能開始。");
    if ((room.settings.teamMode ? room.teamScores : room.scores).some(score => score >= room.settings.scoreToWin)) resetMatch(room);
    room.layoutId = room.settings.mapMode === "official" ? pickLayout(room.settings) : null;
    room.openDoors = room.layoutId === null ? generateMaze().openDoors : LAYOUTS[room.layoutId][1];
    room.open = new Set(room.openDoors); room.roundId = randomUUID(); room.roundNumber++;
    room.status = "playing"; room.startsAt = Date.now() + 3500;
    room.traffic = room.settings.doorMode === "traffic" ? createTrafficSchedule() : null;
    room.coverage = room.settings.doorMode === "coverage" ? coveragePlan(room.open) : null;
    room.rotation = room.settings.doorMode === "rotate" ? { periodMs: ROTATION_PERIOD_MS } : null;
    const reverse = room.settings.doorMode === "reverse";
    room.startI = reverse ? GOAL_I : START_I; room.goalI = reverse ? START_I : GOAL_I;
    for (const player of room.players.values()) { Object.assign(player, spawnPosition(player.slot, reverse)); player.steps = 0; player.revision = 0; player.solvedDoors = new Set(); player.challenge = null; player.coverage = createCoverage(); }
    io.to(room.code).emit("round:start", { roundId: room.roundId, roundNumber: room.roundNumber, layoutId: room.layoutId, openDoors: room.openDoors, settings: room.settings, startI: room.startI, goalI: room.goalI, scores: room.scores, teamScores: room.teamScores, startsAt: room.startsAt, serverNow: Date.now(), countdownMs: 3500, traffic: room.traffic, rotation: room.rotation, coverageTotal: room.coverage?.required.size ?? 0, players: [...room.players.values()].map(({ slot, team, x, y, steps, revision }) => ({ slot, team, x, y, steps, revision })) });
    broadcast(room); reply(ack, { ok: true });
  });
  socket.on("player:state", data => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id);
    if (!player || player.challenge || room.race) return;
    const x = Number(data.x), y = Number(data.y), steps = Number(data.steps);
    if (![x, y, steps].every(Number.isFinite) || x < 10 || x > 810 || y < 10 || y > 810 || !Number.isInteger(steps) || steps < 0 || steps > 1e6) return;
    if (room.traffic) {
      const correction = () => ({ roundId: room.roundId, slot: player.slot, x: player.x, y: player.y, steps: player.steps, revision: player.revision });
      // Ignore in-flight positions from before a teleport.
      if (data.revision !== player.revision) { socket.emit("player:reset", correction()); return; }
      const signal = trafficState(room.traffic, Date.now() - room.startsAt);
      const moved = Math.hypot(x - player.x, y - player.y) > .75;
      const redInput = data.moving === true && data.trafficIndex === signal.index;
      if (signal.phase === "red" && (redInput || (signal.phaseElapsed >= TRAFFIC_GRACE_MS && (moved || data.moving === true)))) {
        Object.assign(player, spawnPosition(player.slot)); player.revision++;
        io.to(room.code).emit("player:reset", { ...correction(), penalized: true });
        return;
      }
    }
    if (room.coverage) {
      const correction = () => ({ roundId: room.roundId, slot: player.slot, x: player.x, y: player.y, steps: player.steps, revision: player.revision, room: player.coverage.room });
      if (data.revision !== player.revision) { socket.emit("player:reset", correction()); return; }
      const result = advanceCoverage(player.coverage, room.coverage, player, { x, y });
      if (!result.valid) { player.revision++; socket.emit("player:reset", correction()); return; }
      if (result.changed) socket.emit("route:progress", { roundId: room.roundId, ...coverageProgress(player.coverage, room.coverage) });
    }
    player.x = x; player.y = y; player.steps = steps;
    socket.to(room.code).emit("player:state", { roundId: room.roundId, slot: player.slot, x, y, steps });
  });
  socket.on("elimination:move", data => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id), race = room?.race;
    if (!race || !player) return;
    const outcome = moveElimination(race, player.slot, data, Date.now());
    if (outcome.ignored) return;
    if (outcome.correction) return socket.emit("elimination:correction", { roundId: room.roundId, ...eliminationState(race).players.find(p => p.slot === player.slot) });
    const state = eliminationState(race);
    io.to(room.code).emit("elimination:state", { roundId: room.roundId, ...state });
    if (race.winner !== null) {
      room.status = "ended"; room.scores[race.winner] = 1;
      const winner = race.players.get(race.winner), finalMap = race.plan[race.finalStage].maps[0];
      io.to(room.code).emit("round:end", { roundId: room.roundId, elimination: true, winner: race.winner, winnerTeam: -1, matchWinner: race.winner, matchWinnerTeam: -1, scores: room.scores, teamScores: room.teamScores, elapsedMs: Date.now() - room.startsAt, steps: winner.steps, players: state.players, rankings: state.players.map(({ slot, rank }) => ({ slot, rank })).sort((a, b) => a.rank - b.rank), routeLengths: room.settings.revealAfterRound ? finalMap.routeLengths : null });
      broadcast(room);
    }
  });
  socket.on("door:discover", data => {
    const room = activeRound(socket, data);
    if (!room?.settings.shareDiscovery || room.race || room.settings.doorMode === "math" || !Number.isInteger(data?.doorId) || data.doorId < 0 || data.doorId >= 39) return;
    shareDoor(room, socket, { roundId: room.roundId, doorId: data.doorId, state: room.open.has(data.doorId) ? 1 : 2 });
  });
  socket.on("door:challenge", (data, ack) => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id);
    if (!player || room.settings.doorMode !== "math") return fail(ack, "目前沒有啟用數學探門，或回合尚未開始／已結束。");
    const doorId = data?.doorId;
    if (!Number.isInteger(doorId) || doorId < 0 || doorId >= GAPS.length) return fail(ack, "無效的門。");
    if (player.challenge && player.challenge.doorId !== doorId) return fail(ack, "請先答對目前的題目。");
    const gap = GAPS[doorId];
    const distance = Math.hypot(player.x - Math.max(gap.x, Math.min(player.x, gap.x + gap.w)), player.y - Math.max(gap.y, Math.min(player.y, gap.y + gap.h)));
    if (distance > PR + 4) return fail(ack, "碰到門才能取得題目。");
    if (player.solvedDoors.has(doorId)) return reply(ack, { ok: true, solved: true, doorId, state: room.open.has(doorId) ? 1 : 2 });
    if (!player.challenge) player.challenge = { id: randomUUID(), doorId, ...generateMathProblem(), attempts: 0 };
    const { id, question, attempts } = player.challenge;
    reply(ack, { ok: true, challenge: { id, doorId, question, attempts } });
  });
  socket.on("door:answer", (data, ack) => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id), challenge = player?.challenge;
    if (!challenge || challenge.id !== data?.challengeId) return fail(ack, "題目已失效，請重新取得題目。");
    challenge.attempts++;
    if (!isCorrectAnswer(data.answer, challenge.answer)) return reply(ack, { ok: true, correct: false, attempts: challenge.attempts });
    player.solvedDoors.add(challenge.doorId); player.challenge = null;
    if (room.settings.shareDiscovery) {
      shareDoor(room, socket, { roundId: room.roundId, doorId: challenge.doorId, state: room.open.has(challenge.doorId) ? 1 : 2, mathSolved: true, by: player.slot }, true);
    }
    reply(ack, { ok: true, correct: true, doorId: challenge.doorId, state: room.open.has(challenge.doorId) ? 1 : 2, attempts: challenge.attempts });
  });
  socket.on("goal:reached", (data, ack) => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id);
    if (!player) return fail(ack, "回合尚未開始或已結束。");
    if (room.race) return fail(ack, "淘汰競速以伺服器賽段進度判定，請沿賽道前進。");
    if (room.traffic && data.revision !== player.revision) return fail(ack, "位置已重置，請重新抵達終點。");
    if (player.challenge) return fail(ack, "請先答對目前的題目。");
    if (room.coverage && data.revision !== player.revision) return fail(ack, "位置已校正，請重新抵達終點。");
    const goalX = pos(room.goalI % 5), goalY = pos(Math.floor(room.goalI / 5));
    if (player.x < goalX || player.x > goalX + ROOM || player.y < goalY || player.y > goalY + ROOM) return fail(ack, `尚未抵達 ${room.goalI === START_I ? "A3" : "E3"} 終點。`);
    if (room.coverage && !coverageProgress(player.coverage, room.coverage).ready) return fail(ack, `王冠尚未解鎖：還需要親自走過 ${room.coverage.required.size - player.coverage.doors.size} 個路段。`);
    room.status = "ended"; room.scores[player.slot]++;
    const winnerTeam = room.settings.teamMode ? player.team : -1;
    if (winnerTeam !== -1) room.teamScores[winnerTeam]++;
    const matchDone = (room.settings.teamMode ? room.teamScores[winnerTeam] : room.scores[player.slot]) >= room.settings.scoreToWin;
    io.to(room.code).emit("round:end", { roundId: room.roundId, winner: player.slot, winnerTeam, scores: room.scores, teamScores: room.teamScores, matchWinner: matchDone ? player.slot : -1, matchWinnerTeam: matchDone ? winnerTeam : -1, elapsedMs: Date.now() - room.startsAt, steps: player.steps, players: [...room.players.values()].map(({ slot, team, x, y, steps }) => ({ slot, team, x, y, steps })), routeLengths: room.settings.revealAfterRound ? allPaths(room.open).map(path => path.length - 1) : null });
    broadcast(room); reply(ack, { ok: true });
  });
  socket.on("disconnect", () => leave(socket));
});
const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, "0.0.0.0", () => console.log(`迷途神廟線上對戰：http://localhost:${port}`));
