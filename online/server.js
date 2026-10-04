import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const INDEX_PATH = join(ROOT, "index.html");
const indexSource = await readFile(INDEX_PATH, "utf8");
const layoutsLiteral = indexSource.match(/const LAYOUTS = (\[[\s\S]*?\n\]);/);
if (!layoutsLiteral) throw new Error("找不到 LAYOUTS 資料");
const LAYOUTS = JSON.parse(layoutsLiteral[1].replace(/,\s*]$/, "]"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = normalize(join(ROOT, relative));
    if (!filePath.startsWith(ROOT)) throw new Error("invalid path");
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

const io = new Server(httpServer, { serveClient: true });
const rooms = new Map();
const DEFAULT_SETTINGS = Object.freeze({
  drawMode: "weighted",
  layoutMode: "random",
  fixedLayout: 0,
  scoreToWin: 3,
  shareDiscovery: true,
  revealAfterRound: true,
});

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let tries = 0; tries < 100; tries++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[(Math.random() * chars.length) | 0];
    if (!rooms.has(code)) return code;
  }
  throw new Error("無法建立房號");
}

function cleanName(value, fallback) {
  const name = String(value || "").trim().slice(0, 16);
  return name || fallback;
}

function cleanSettings(value = {}) {
  return {
    drawMode: value.drawMode === "uniform" ? "uniform" : "weighted",
    layoutMode: value.layoutMode === "fixed" ? "fixed" : "random",
    fixedLayout: Math.max(0, Math.min(LAYOUTS.length - 1, Number(value.fixedLayout) | 0)),
    scoreToWin: [1, 3, 5, 7].includes(Number(value.scoreToWin)) ? Number(value.scoreToWin) : 3,
    shareDiscovery: value.shareDiscovery !== false,
    revealAfterRound: value.revealAfterRound !== false,
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    status: room.status,
    scores: room.scores,
    players: [...room.players.entries()].map(([id, player]) => ({ id, ...player })),
  };
}

function findRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function pickLayout(settings) {
  if (settings.layoutMode === "fixed") return settings.fixedLayout;
  if (settings.drawMode === "uniform") return (Math.random() * LAYOUTS.length) | 0;
  const total = LAYOUTS.reduce((sum, layout) => sum + layout[0], 0);
  let roll = Math.random() * total;
  for (let i = 0; i < LAYOUTS.length; i++) {
    roll -= LAYOUTS[i][0];
    if (roll <= 0) return i;
  }
  return LAYOUTS.length - 1;
}

function reply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

io.on("connection", socket => {
  socket.on("room:create", (data, ack) => {
    if (findRoom(socket)) return reply(ack, { ok: false, error: "你已經在房間內" });
    const code = roomCode();
    const room = {
      code,
      hostId: socket.id,
      settings: { ...DEFAULT_SETTINGS },
      status: "lobby",
      scores: [0, 0],
      players: new Map([[socket.id, { slot: 0, name: cleanName(data?.name, "主辦者") }]]),
      layoutId: -1,
    };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    reply(ack, { ok: true, slot: 0, room: publicRoom(room) });
    io.to(code).emit("room:state", publicRoom(room));
  });

  socket.on("room:join", (data, ack) => {
    if (findRoom(socket)) return reply(ack, { ok: false, error: "你已經在房間內" });
    const code = String(data?.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply(ack, { ok: false, error: "找不到這個房間" });
    if (room.players.size >= 2) return reply(ack, { ok: false, error: "房間已滿" });
    if (room.status === "playing") return reply(ack, { ok: false, error: "對戰已經開始" });
    room.players.set(socket.id, { slot: 1, name: cleanName(data?.name, "挑戰者") });
    socket.data.roomCode = code;
    socket.join(code);
    reply(ack, { ok: true, slot: 1, room: publicRoom(room) });
    io.to(code).emit("room:state", publicRoom(room));
  });

  socket.on("settings:update", (data, ack) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return reply(ack, { ok: false, error: "只有主辦者可以調整設定" });
    if (room.status === "playing") return reply(ack, { ok: false, error: "回合進行中不能改設定" });
    room.settings = cleanSettings(data);
    io.to(room.code).emit("room:state", publicRoom(room));
    reply(ack, { ok: true });
  });

  socket.on("round:start", (_, ack) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return reply(ack, { ok: false, error: "只有主辦者可以開始" });
    if (room.players.size !== 2) return reply(ack, { ok: false, error: "需要兩名玩家" });
    if (room.status === "playing") return reply(ack, { ok: false, error: "回合已經在進行中" });
    if (room.scores.some(score => score >= room.settings.scoreToWin)) room.scores = [0, 0];
    room.layoutId = pickLayout(room.settings);
    room.status = "playing";
    io.to(room.code).emit("round:start", {
      layoutId: room.layoutId,
      settings: room.settings,
      scores: room.scores,
      startsAt: Date.now() + 800,
    });
    reply(ack, { ok: true });
  });

  socket.on("player:state", data => {
    const room = findRoom(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.status !== "playing") return;
    const x = Number(data?.x), y = Number(data?.y), steps = Number(data?.steps) | 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 820 || y < 0 || y > 820) return;
    player.x = x; player.y = y; player.steps = Math.max(0, steps);
    socket.to(room.code).emit("player:state", { slot: player.slot, x, y, steps: Math.max(0, steps) });
  });

  socket.on("door:discover", data => {
    const room = findRoom(socket);
    if (!room || room.status !== "playing" || !room.settings.shareDiscovery) return;
    const doorId = Number(data?.doorId) | 0;
    const state = Number(data?.state) | 0;
    if (doorId < 0 || doorId >= 39 || (state !== 1 && state !== 2)) return;
    socket.to(room.code).emit("door:discover", { doorId, state });
  });

  socket.on("goal:reached", () => {
    const room = findRoom(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.status !== "playing") return;
    const x = Number(player.x), y = Number(player.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 340 || x > 480 || y < 20 || y > 160) return;
    room.status = "ended";
    room.scores[player.slot]++;
    io.to(room.code).emit("round:end", {
      winner: player.slot,
      scores: room.scores,
      matchWinner: room.scores[player.slot] >= room.settings.scoreToWin ? player.slot : -1,
    });
    io.to(room.code).emit("room:state", publicRoom(room));
  });

  socket.on("disconnect", () => {
    const room = findRoom(socket);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.hostId === socket.id) {
      socket.to(room.code).emit("room:closed", "主辦者已離開，房間已關閉");
      rooms.delete(room.code);
      return;
    }
    room.status = "lobby";
    room.scores = [0, 0];
    io.to(room.code).emit("room:state", publicRoom(room));
  });
});

const port = Number(process.env.PORT) || 3000;
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`迷途神廟線上版：http://localhost:${port}`);
});
