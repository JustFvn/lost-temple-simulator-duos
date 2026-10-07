import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, randomInt } from "node:crypto";
import { extname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { LAYOUTS } from "./public/layouts.js";
import { allPaths, GAPS, PR } from "./public/geometry.js";
import { generateMaze } from "./maze.js";
import { generateMathProblem, isCorrectAnswer } from "./math-challenge.js";
import { createTrafficSchedule, trafficState, TRAFFIC_GRACE_MS } from "./public/traffic.js";
import { MAX_PLAYERS, emptyScores, spawnPosition, availableSlot } from "./public/players.js";

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
const DEFAULT_SETTINGS = { mapMode: "official", viewMode: "standard", doorMode: "normal", drawMode: "weighted", layoutMode: "random", fixedLayout: 0, scoreToWin: 3, shareDiscovery: true, revealAfterRound: true };
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
  if (!["normal", "math", "traffic"].includes(doorMode)) throw new Error("無效的遊戲玩法。");
  return { mapMode: value.mapMode, viewMode, doorMode, drawMode: value.drawMode === "uniform" ? "uniform" : "weighted", layoutMode: value.layoutMode === "fixed" ? "fixed" : "random", fixedLayout, scoreToWin, shareDiscovery: value.shareDiscovery !== false, revealAfterRound: value.revealAfterRound !== false };
}
function publicRoom(room) {
  return { code: room.code, hostId: room.hostId, maxPlayers: MAX_PLAYERS, settings: room.settings, status: room.status, scores: room.scores, roundNumber: room.roundNumber, players: [...room.players].map(([id, player]) => ({ id, slot: player.slot, name: player.name })) };
}
const broadcast = room => io.to(room.code).emit("room:state", publicRoom(room));
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
    room.status = "lobby"; room.scores = emptyScores(); room.roundNumber = 0; room.roundId = null;
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
    const room = { code, hostId: socket.id, settings: { ...DEFAULT_SETTINGS }, status: "lobby", scores: emptyScores(), roundNumber: 0, roundId: null, players: new Map([[socket.id, { slot: 0, name: cleanName(data?.name, "主辦者") }]]) };
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
    room.players.set(socket.id, { slot, name: cleanName(data?.name, `挑戰者 ${slot + 1}`) });
    // A new participant starts a fresh match; never inherit a vacated score.
    room.scores = emptyScores(); room.roundNumber = 0; room.roundId = null; room.status = "lobby";
    socket.data.roomCode = room.code; socket.join(room.code);
    reply(ack, { ok: true, slot, room: publicRoom(room) }); broadcast(room);
  });
  socket.on("room:leave", (_, ack) => { leave(socket); reply(ack, { ok: true }); });
  socket.on("settings:update", (data, ack) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return fail(ack, "只有房主可以調整設定。");
    if (room.status === "playing") return fail(ack, "回合中不能修改設定。");
    try {
      const settings = cleanSettings(data);
      if (JSON.stringify(settings) !== JSON.stringify(room.settings)) {
        room.settings = settings; room.scores = emptyScores(); room.roundNumber = 0; room.status = "lobby";
      }
      broadcast(room); reply(ack, { ok: true });
    } catch (error) { fail(ack, error.message); }
  });
  socket.on("round:start", (_, ack) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return fail(ack, "只有房主可以開始回合。");
    if (room.players.size < 2) return fail(ack, "至少需要兩位玩家，最多四人。");
    if (room.status === "playing") return fail(ack, "回合已經開始。");
    if (room.scores.some(score => score >= room.settings.scoreToWin)) { room.scores = emptyScores(); room.roundNumber = 0; }
    room.layoutId = room.settings.mapMode === "official" ? pickLayout(room.settings) : null;
    room.openDoors = room.layoutId === null ? generateMaze().openDoors : LAYOUTS[room.layoutId][1];
    room.open = new Set(room.openDoors); room.roundId = randomUUID(); room.roundNumber++;
    room.status = "playing"; room.startsAt = Date.now() + 3500;
    room.traffic = room.settings.doorMode === "traffic" ? createTrafficSchedule() : null;
    for (const player of room.players.values()) { Object.assign(player, spawnPosition(player.slot)); player.steps = 0; player.revision = 0; player.solvedDoors = new Set(); player.challenge = null; }
    io.to(room.code).emit("round:start", { roundId: room.roundId, roundNumber: room.roundNumber, layoutId: room.layoutId, openDoors: room.openDoors, settings: room.settings, scores: room.scores, startsAt: room.startsAt, serverNow: Date.now(), countdownMs: 3500, traffic: room.traffic, players: [...room.players.values()].map(({ slot, x, y, steps, revision }) => ({ slot, x, y, steps, revision })) });
    broadcast(room); reply(ack, { ok: true });
  });
  socket.on("player:state", data => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id);
    if (!player || player.challenge) return;
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
    player.x = x; player.y = y; player.steps = steps;
    socket.to(room.code).emit("player:state", { roundId: room.roundId, slot: player.slot, x, y, steps });
  });
  socket.on("door:discover", data => {
    const room = activeRound(socket, data);
    if (!room?.settings.shareDiscovery || room.settings.doorMode === "math" || !Number.isInteger(data?.doorId) || data.doorId < 0 || data.doorId >= 39) return;
    socket.to(room.code).emit("door:discover", { roundId: room.roundId, doorId: data.doorId, state: room.open.has(data.doorId) ? 1 : 2 });
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
      io.to(room.code).emit("door:discover", { roundId: room.roundId, doorId: challenge.doorId, state: room.open.has(challenge.doorId) ? 1 : 2, mathSolved: true, by: player.slot });
    }
    reply(ack, { ok: true, correct: true, doorId: challenge.doorId, state: room.open.has(challenge.doorId) ? 1 : 2, attempts: challenge.attempts });
  });
  socket.on("goal:reached", (data, ack) => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id);
    if (!player) return fail(ack, "回合尚未開始或已結束。");
    if (room.traffic && data.revision !== player.revision) return fail(ack, "位置已重置，請重新抵達終點。");
    if (player.challenge) return fail(ack, "請先答對目前的題目。");
    if (player.x < 340 || player.x > 480 || player.y < 20 || player.y > 160) return fail(ack, "尚未抵達 E3 終點。");
    room.status = "ended"; room.scores[player.slot]++;
    io.to(room.code).emit("round:end", { roundId: room.roundId, winner: player.slot, scores: room.scores, matchWinner: room.scores[player.slot] >= room.settings.scoreToWin ? player.slot : -1, elapsedMs: Date.now() - room.startsAt, steps: player.steps, players: [...room.players.values()].map(({ slot, x, y, steps }) => ({ slot, x, y, steps })), routeLengths: room.settings.revealAfterRound ? allPaths(room.open).map(path => path.length - 1) : null });
    broadcast(room); reply(ack, { ok: true });
  });
  socket.on("disconnect", () => leave(socket));
});
const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, "0.0.0.0", () => console.log(`迷途神廟線上對戰：http://localhost:${port}`));
