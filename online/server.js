import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, randomInt } from "node:crypto";
import { extname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { LAYOUTS } from "./public/layouts.js";
import { allPaths } from "./public/geometry.js";
import { generateMaze } from "./maze.js";

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
const DEFAULT_SETTINGS = { mapMode: "official", drawMode: "weighted", layoutMode: "random", fixedLayout: 0, scoreToWin: 3, shareDiscovery: true, revealAfterRound: true };
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
  return { mapMode: value.mapMode, drawMode: value.drawMode === "uniform" ? "uniform" : "weighted", layoutMode: value.layoutMode === "fixed" ? "fixed" : "random", fixedLayout, scoreToWin, shareDiscovery: value.shareDiscovery !== false, revealAfterRound: value.revealAfterRound !== false };
}
function publicRoom(room) {
  return { code: room.code, hostId: room.hostId, settings: room.settings, status: room.status, scores: room.scores, roundNumber: room.roundNumber, players: [...room.players].map(([id, player]) => ({ id, slot: player.slot, name: player.name })) };
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
    room.status = "lobby"; room.scores = [0, 0]; room.roundNumber = 0; room.roundId = null;
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
    const room = { code, hostId: socket.id, settings: { ...DEFAULT_SETTINGS }, status: "lobby", scores: [0, 0], roundNumber: 0, roundId: null, players: new Map([[socket.id, { slot: 0, name: cleanName(data?.name, "主辦者") }]]) };
    rooms.set(code, room); socket.data.roomCode = code; socket.join(code);
    reply(ack, { ok: true, slot: 0, room: publicRoom(room) }); broadcast(room);
  });
  socket.on("room:join", (data, ack) => {
    if (findRoom(socket)) return fail(ack, "你已經在房間內。");
    const room = rooms.get(String(data?.code || "").trim().toUpperCase());
    if (!room) return fail(ack, "找不到房間，請確認房號或請房主重新建立。");
    if (room.players.size >= 2) return fail(ack, "房間已滿。");
    if (room.status === "playing") return fail(ack, "對戰已開始。");
    room.players.set(socket.id, { slot: 1, name: cleanName(data?.name, "挑戰者") });
    socket.data.roomCode = room.code; socket.join(room.code);
    reply(ack, { ok: true, slot: 1, room: publicRoom(room) }); broadcast(room);
  });
  socket.on("room:leave", (_, ack) => { leave(socket); reply(ack, { ok: true }); });
  socket.on("settings:update", (data, ack) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return fail(ack, "只有房主可以調整設定。");
    if (room.status === "playing") return fail(ack, "回合中不能修改設定。");
    try {
      const settings = cleanSettings(data);
      if (JSON.stringify(settings) !== JSON.stringify(room.settings)) {
        room.settings = settings; room.scores = [0, 0]; room.roundNumber = 0; room.status = "lobby";
      }
      broadcast(room); reply(ack, { ok: true });
    } catch (error) { fail(ack, error.message); }
  });
  socket.on("round:start", (_, ack) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return fail(ack, "只有房主可以開始回合。");
    if (room.players.size !== 2) return fail(ack, "需要兩位玩家。");
    if (room.status === "playing") return fail(ack, "回合已經開始。");
    if (room.scores.some(score => score >= room.settings.scoreToWin)) { room.scores = [0, 0]; room.roundNumber = 0; }
    room.layoutId = room.settings.mapMode === "official" ? pickLayout(room.settings) : null;
    room.openDoors = room.layoutId === null ? generateMaze().openDoors : LAYOUTS[room.layoutId][1];
    room.open = new Set(room.openDoors); room.roundId = randomUUID(); room.roundNumber++;
    room.status = "playing"; room.startsAt = Date.now() + 3500;
    for (const player of room.players.values()) { player.x = 392 + player.slot * 36; player.y = 730; player.steps = 0; }
    io.to(room.code).emit("round:start", { roundId: room.roundId, roundNumber: room.roundNumber, layoutId: room.layoutId, openDoors: room.openDoors, settings: room.settings, scores: room.scores, startsAt: room.startsAt, serverNow: Date.now(), countdownMs: 3500 });
    broadcast(room); reply(ack, { ok: true });
  });
  socket.on("player:state", data => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id);
    if (!player) return;
    const x = Number(data.x), y = Number(data.y), steps = Number(data.steps);
    if (![x, y, steps].every(Number.isFinite) || x < 10 || x > 810 || y < 10 || y > 810 || !Number.isInteger(steps) || steps < 0 || steps > 1e6) return;
    player.x = x; player.y = y; player.steps = steps;
    socket.to(room.code).emit("player:state", { roundId: room.roundId, slot: player.slot, x, y, steps });
  });
  socket.on("door:discover", data => {
    const room = activeRound(socket, data);
    if (!room?.settings.shareDiscovery || !Number.isInteger(data?.doorId) || data.doorId < 0 || data.doorId >= 39) return;
    socket.to(room.code).emit("door:discover", { roundId: room.roundId, doorId: data.doorId, state: room.open.has(data.doorId) ? 1 : 2 });
  });
  socket.on("goal:reached", (data, ack) => {
    const room = activeRound(socket, data), player = room?.players.get(socket.id);
    if (!player) return fail(ack, "回合尚未開始或已結束。");
    if (player.x < 340 || player.x > 480 || player.y < 20 || player.y > 160) return fail(ack, "尚未抵達 E3 終點。");
    room.status = "ended"; room.scores[player.slot]++;
    io.to(room.code).emit("round:end", { roundId: room.roundId, winner: player.slot, scores: room.scores, matchWinner: room.scores[player.slot] >= room.settings.scoreToWin ? player.slot : -1, elapsedMs: Date.now() - room.startsAt, steps: player.steps, players: [...room.players.values()].map(({ slot, x, y, steps }) => ({ slot, x, y, steps })), routeLengths: room.settings.revealAfterRound ? allPaths(room.open).map(path => path.length - 1) : null });
    broadcast(room); reply(ack, { ok: true });
  });
  socket.on("disconnect", () => leave(socket));
});
const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, "0.0.0.0", () => console.log(`迷途神廟線上對戰：http://localhost:${port}`));
