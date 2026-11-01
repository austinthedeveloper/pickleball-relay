// The relay: rooms by code for Pickleball '94's games and Sundown Run (port ADR-105,
// pickleball-port-kit design/RELAY.md). It knows nothing of pickleball: it
// pairs WebSocket connections in rooms and passes their messages on.
//
//   wss://<relay>/v1/host?game=pb94-port&ver=0.43.0  -> {"op":"room","code":"BXKM"}
//   wss://<relay>/v1/join?game=pb94-port&code=BXKM   -> {"op":"welcome","you":0,"ver":...}
//   GET /healthz                                     -> 200 "ok"
//   GET /c/BXKM                                      -> the page that room's host sent
//   GET /                                            -> a box for the room code, to /c/<code>
//
// Binary frames carry the games' messages. The host's have a one-byte
// header both ways: the guest's number, or 255 for "all" (host to guests).
// Guests send and receive bare payloads. Text frames are control messages,
// short JSON with an "op".
"use strict";

const http = require("http");
const { WebSocketServer } = require("ws");

// Four letters, consonants only: no I or O to misread, and no vowels, so no words.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const CODE_LEN = 4;
const ALL = 255;

// The front door: a coach types the room the headset shows and goes to its page.
const FRONT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pickleball '94 Coach</title>
<style>
  body { margin: 0; background: #0b1020; color: #e8ecf8; font: 16px/1.4 -apple-system, system-ui, sans-serif;
         display: grid; place-items: center; min-height: 100vh; padding: 0 16px; box-sizing: border-box; }
  main { width: 100%; max-width: 360px; text-align: center; }
  h1 { color: #f2c230; font-size: 20px; letter-spacing: .04em; }
  input { width: 100%; box-sizing: border-box; font-size: 32px; text-align: center; letter-spacing: .3em;
          text-transform: uppercase; padding: 10px; border-radius: 10px; border: 2px solid #2a355a;
          background: #141b31; color: #e8ecf8; }
  button { width: 100%; margin-top: 12px; font-size: 18px; font-weight: 700; padding: 14px; border: 0;
           border-radius: 10px; background: #3ddc84; color: #0b1020; }
  p { color: #8e9ac0; }
</style></head><body><main>
<h1>PICKLEBALL '94 COACH</h1>
<p>Enter the room shown on the headset's COACH page.</p>
<form onsubmit="go(); return false"><input id="room" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ROOM">
<button>OPEN</button></form>
<script>
function go() {
  const r = document.getElementById("room").value.trim().toUpperCase();
  if (/^[A-Z]{4}$/.test(r)) location.href = "/c/" + r;
}
</script></main></body></html>`;

const GAMES = {
  "pb94-port": 1,       // ONLINE: one guest
  "pb94-vr-coach": 8,   // coach phones
  "pb94-vr": 3,         // future VR online
  "sundown-run": 3,     // Sundown Run's online races: four players (arcade-racer ON-1)
};

const DEFAULTS = {
  port: Number(process.env.PORT) || 8080,
  maxMessage: 1 << 20,          // 1 MiB
  ratePerSec: 200,              // messages a second per connection
  roomsPerMinute: 10,           // rooms opened per IP
  missesPerMinute: 20,          // wrong rooms tried per IP (a room is the coach's only key)
  maxConnections: 500,
  idleMs: 10 * 60 * 1000,       // a room with no messages for this long ends
  capMs: 4 * 60 * 60 * 1000,    // and every room ends after this
  pingMs: 15 * 1000,
  sweepMs: 30 * 1000,
  log: console.log,
};

function createRelay(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const rooms = new Map();          // "game/CODE" -> room
  const opened = new Map();         // ip -> [times rooms were opened]
  const missed = new Map();         // ip -> [times a wrong room was tried]
  let connections = 0;
  const stats = { rooms: 0, joins: 0, messages: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://relay");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(FRONT);
    }
    const page = url.pathname.match(/^\/c\/([A-Za-z]{4})\/?$/);
    if (page) {
      const ip = ipOf(req);
      if (tooManyMisses(ip)) {
        res.writeHead(429, { "content-type": "text/plain", "retry-after": "60" });
        return res.end("TOO MANY TRIES");
      }
      const room = rooms.get("pb94-vr-coach/" + page[1].toUpperCase());
      if (room && room.page) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(room.page);
      }
      miss(ip);
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("NO SUCH ROOM");
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: o.maxMessage });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://relay");
    const role = { "/v1/host": "host", "/v1/join": "guest" }[url.pathname];
    if (!role) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => welcome(ws, role, url, ipOf(req)));
  });

  // Behind Azure's ingress the caller is the first X-Forwarded-For address.
  function ipOf(req) {
    const fwd = req.headers["x-forwarded-for"];
    return (fwd ? String(fwd).split(",")[0] : req.socket.remoteAddress || "").trim();
  }

  // The room is all a coach needs, so wrong rooms are counted per address:
  // past missesPerMinute, that address waits a minute (20 a minute from one
  // address would take days to find one room among 160,000).
  function recent(map, ip) {
    const now = Date.now();
    return (map.get(ip) || []).filter((t) => now - t < 60 * 1000);
  }
  function tooManyMisses(ip) {
    return recent(missed, ip).length >= o.missesPerMinute;
  }
  function miss(ip) {
    const times = recent(missed, ip);
    times.push(Date.now());
    missed.set(ip, times);
  }

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function refuse(ws, reason) {
    send(ws, { op: "error", reason });
    ws.close(1008, reason);
  }

  function newCode(game) {
    for (let tries = 0; tries < 100; tries++) {
      let code = "";
      for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      if (!rooms.has(game + "/" + code)) return code;
    }
    return null;
  }

  function welcome(ws, role, url, ip) {
    connections++;
    ws.on("close", () => connections--);
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    ws.on("error", () => {});
    ws.bucket = { tokens: o.ratePerSec, at: Date.now() };

    const game = url.searchParams.get("game") || "";
    const ver = (url.searchParams.get("ver") || "").slice(0, 32);
    if (connections > o.maxConnections) return refuse(ws, "SERVER FULL");
    if (!(game in GAMES)) return refuse(ws, "NO SUCH GAME");
    if (role === "host") return openRoom(ws, game, ver, ip);
    joinRoom(ws, game, (url.searchParams.get("code") || "").toUpperCase(), ver, ip);
  }

  function openRoom(ws, game, ver, ip) {
    const now = Date.now();
    const times = (opened.get(ip) || []).filter((t) => now - t < 60 * 1000);
    if (times.length >= o.roomsPerMinute) return refuse(ws, "TOO MANY ROOMS");
    times.push(now);
    opened.set(ip, times);
    const code = newCode(game);
    if (!code) return refuse(ws, "SERVER FULL");
    const room = { key: game + "/" + code, game, code, ver, host: ws, guests: new Array(GAMES[game]).fill(null),
                   page: null, born: now, last: now };
    rooms.set(room.key, room);
    stats.rooms++;
    o.log(`room open ${game} (rooms ${rooms.size}, connections ${connections})`);
    send(ws, { op: "room", code });

    ws.on("message", (data, binary) => {
      if (!allowed(ws)) return;
      room.last = Date.now();
      if (!binary) return hostControl(room, data);
      if (data.length < 1) return;
      stats.messages++;
      const to = data[0];
      const payload = data.subarray(1);
      if (to === ALL) {
        for (const g of room.guests) if (g && g.readyState === g.OPEN) g.send(payload, { binary: true });
      } else {
        const g = room.guests[to];
        if (g && g.readyState === g.OPEN) g.send(payload, { binary: true });
      }
    });
    ws.on("close", () => closeRoom(room, "HOST LEFT"));
  }

  // The host's text frames: {"op":"page","html":...} sets the room's page (VR coach rooms).
  function hostControl(room, data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg && msg.op === "page" && room.game === "pb94-vr-coach" && typeof msg.html === "string") {
      room.page = msg.html;
    }
  }

  function joinRoom(ws, game, code, ver, ip) {
    if (tooManyMisses(ip)) return refuse(ws, "TOO MANY TRIES");
    const room = rooms.get(game + "/" + code);
    if (!room) {
      miss(ip);
      return refuse(ws, "NO SUCH ROOM");
    }
    const you = room.guests.indexOf(null);
    if (you < 0) return refuse(ws, "ROOM FULL");
    room.guests[you] = ws;
    room.last = Date.now();
    stats.joins++;
    send(ws, { op: "welcome", you, ver: room.ver });
    send(room.host, { op: "joined", guest: you, ver });

    ws.on("message", (data, binary) => {
      if (!allowed(ws) || !binary) return;
      room.last = Date.now();
      stats.messages++;
      const h = room.host;
      if (h.readyState !== h.OPEN) return;
      const out = Buffer.allocUnsafe(data.length + 1);
      out[0] = you;
      data.copy(out, 1);
      h.send(out, { binary: true });
    });
    ws.on("close", () => {
      if (room.guests[you] !== ws) return;
      room.guests[you] = null;
      send(room.host, { op: "left", guest: you });
    });
  }

  function closeRoom(room, reason) {
    if (rooms.get(room.key) !== room) return;
    rooms.delete(room.key);
    for (const g of room.guests) if (g) refuse(g, reason);
    if (room.host.readyState === room.host.OPEN) refuse(room.host, reason);
    o.log(`room closed (${reason.toLowerCase()}) after ${Math.round((Date.now() - room.born) / 1000)} s (rooms ${rooms.size})`);
  }

  // A token bucket per connection; past it, the connection is closed.
  function allowed(ws) {
    const now = Date.now();
    const b = ws.bucket;
    b.tokens = Math.min(o.ratePerSec, b.tokens + ((now - b.at) / 1000) * o.ratePerSec);
    b.at = now;
    if (b.tokens < 1) {
      refuse(ws, "TOO FAST");
      return false;
    }
    b.tokens -= 1;
    return true;
  }

  // Pings keep idle connections open through the ingress and find dead ones.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, o.pingMs);

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (now - room.last > o.idleMs) closeRoom(room, "IDLE");
      else if (now - room.born > o.capMs) closeRoom(room, "TIME UP");
    }
    for (const map of [opened, missed]) {
      for (const [ip, times] of map) if (times.every((t) => now - t > 60 * 1000)) map.delete(ip);
    }
  }, o.sweepMs);

  return {
    server,
    rooms,
    stats,
    listen(port = o.port) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(pinger);
      clearInterval(sweeper);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createRelay, GAMES, ALPHABET, ALL };

if (require.main === module) {
  const relay = createRelay();
  relay.listen().then((port) => console.log(`relay listening on ${port}`));
  const stop = () => relay.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
