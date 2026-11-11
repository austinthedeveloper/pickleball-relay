// Two fake games over a local relay: rooms, codes, fan-out, limits.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createRelay, compareVersions, parseOldest, ALPHABET, ALL } = require("../server");

async function start(t, options = {}) {
  const relay = createRelay({ log: () => {}, ...options });
  const port = await relay.listen(0);
  t.after(() => relay.close());
  return { relay, port, url: `ws://127.0.0.1:${port}` };
}

// A client that queues what it receives: text as parsed JSON, binary as Buffers.
function client(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const inbox = [];
  const waiting = [];
  ws.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("message", (data, binary) => {
    const msg = binary ? Buffer.from(data) : JSON.parse(String(data));
    const w = waiting.shift();
    if (w) w(msg); else inbox.push(msg);
  });
  ws.on("error", () => {});
  ws.next = () => {
    if (inbox.length) return Promise.resolve(inbox.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("nothing arrived")), 2000);
      waiting.push((m) => { clearTimeout(timer); resolve(m); });
    });
  };
  ws.opened = new Promise((resolve) => ws.on("open", resolve));
  return ws;
}

async function host(url, game = "pb94-port", ver = "1.0.0", headers) {
  const h = client(`${url}/v1/host?game=${game}&ver=${ver}`, headers);
  const msg = await h.next();
  assert.equal(msg.op, "room");
  return { h, code: msg.code };
}

async function join(url, code, game = "pb94-port", ver = "1.0.0", headers) {
  const g = client(`${url}/v1/join?game=${game}&code=${code}&ver=${ver}`, headers);
  return { g, msg: await g.next() };
}

function get(port, path, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers }).then(async (r) => ({ status: r.status, body: await r.text() }));
}

test("healthz says ok, and the front door asks for a room", async (t) => {
  const { port } = await start(t);
  assert.deepEqual(await get(port, "/healthz"), { status: 200, body: "ok" });
  const front = await get(port, "/");
  assert.equal(front.status, 200);
  assert.match(front.body, /Enter the room/);
});

test("a host gets a four-letter code from the alphabet", async (t) => {
  const { url } = await start(t);
  const { h, code } = await host(url);
  assert.match(code, new RegExp(`^[${ALPHABET}]{4}$`));
  h.close();
});

test("a guest joins, and messages go both ways", async (t) => {
  const { url } = await start(t);
  const { h, code } = await host(url, "pb94-port", "0.43.0");
  const { g, msg } = await join(url, code.toLowerCase(), "pb94-port", "0.42.0");
  assert.deepEqual(msg, { op: "welcome", you: 0, ver: "0.43.0" });
  assert.deepEqual(await h.next(), { op: "joined", guest: 0, ver: "0.42.0" });
  g.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(await h.next(), Buffer.from([0, 1, 2, 3]));
  h.send(Buffer.from([0, 9, 8]));
  assert.deepEqual(await g.next(), Buffer.from([9, 8]));
  h.close();
});

test("the host reaches one guest or all of them", async (t) => {
  const { url } = await start(t);
  const { h, code } = await host(url, "pb94-vr-coach");
  const a = await join(url, code, "pb94-vr-coach");
  const b = await join(url, code, "pb94-vr-coach");
  assert.equal(a.msg.you, 0);
  assert.equal(b.msg.you, 1);
  await h.next();
  await h.next();
  h.send(Buffer.from([1, 42]));
  h.send(Buffer.from([ALL, 7]));
  assert.deepEqual(await a.g.next(), Buffer.from([7]));
  assert.deepEqual(await b.g.next(), Buffer.from([42]));
  assert.deepEqual(await b.g.next(), Buffer.from([7]));
  h.close();
});

test("a Sundown Run room holds four players, and the host hears each guest apart", async (t) => {
  const { url } = await start(t);
  const { h, code } = await host(url, "sundown-run", "0.2.0");
  const guests = [];
  for (let i = 0; i < 3; i++) {
    const j = await join(url, code, "sundown-run", "0.2.0");
    assert.deepEqual(j.msg, { op: "welcome", you: i, ver: "0.2.0" });
    assert.deepEqual(await h.next(), { op: "joined", guest: i, ver: "0.2.0" });
    guests.push(j.g);
  }
  assert.deepEqual((await join(url, code, "sundown-run")).msg, { op: "error", reason: "ROOM FULL" });
  guests[2].send(Buffer.from([9]));
  assert.deepEqual(await h.next(), Buffer.from([2, 9]));
  h.send(Buffer.from([ALL, 5]));
  for (const g of guests) assert.deepEqual(await g.next(), Buffer.from([5]));
  // A racer's code is no port's
  assert.deepEqual((await join(url, code)).msg, { op: "error", reason: "NO SUCH ROOM" });
  h.close();
});

test("a port host sizes its room (doubles and watchers), up to the game's most", async (t) => {
  const { url } = await start(t);
  const h = client(`${url}/v1/host?game=pb94-port&ver=1.0.0&guests=7`);
  const { code } = await h.next();
  const guests = [];
  for (let i = 0; i < 7; i++) guests.push(await join(url, code));
  assert.ok(guests.every((g) => g.msg.op === "welcome"), "seven guests in");
  assert.deepEqual((await join(url, code)).msg, { op: "error", reason: "ROOM FULL" });
  const big = client(`${url}/v1/host?game=pb94-port&ver=1.0.0&guests=99`);
  const room = (await big.next()).code;
  for (let i = 0; i < 7; i++) await join(url, room);
  assert.deepEqual((await join(url, room)).msg, { op: "error", reason: "ROOM FULL" }, "capped at the game's 7");
  // the host of a big room may send for each of its guests: 4x the rate
  const burst = [];
  for (let i = 0; i < 500; i++) burst.push(Buffer.from([0, i & 0xff]));
  for (const b of burst) h.send(b);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.readyState, h.OPEN, "500 at once from a big room's host is allowed");
  for (const g of guests) g.g.close();
  h.close();
  big.close();
});

test("versions compare by number, and OLDEST_VERSIONS reads as game=version pairs", () => {
  assert.equal(compareVersions("0.5.10", "0.5.9"), 1);
  assert.equal(compareVersions("0.5.2", "0.6.0"), -1);
  assert.equal(compareVersions("v0.6", "0.6.0"), 0);
  assert.deepEqual(parseOldest(""), {});
  assert.deepEqual(parseOldest("sundown-run=0.6.0, pb94-port = 0.43.0,junk,=1.0"),
                   { "sundown-run": "0.6.0", "pb94-port": "0.43.0" });
});

test("an older version is refused with OLD VERSION, host or guest (arcade-racer ON-14)", async (t) => {
  const { url, relay } = await start(t, { oldest: { "sundown-run": "0.6.0" } });
  const oldHost = client(`${url}/v1/host?game=sundown-run&ver=0.5.9`);
  assert.deepEqual(await oldHost.next(), { op: "error", reason: "OLD VERSION" });
  assert.equal(await oldHost.closed, 1008);
  const { h, code } = await host(url, "sundown-run", "0.6.0");
  const old = await join(url, code, "sundown-run", "0.5.10");
  assert.deepEqual(old.msg, { op: "error", reason: "OLD VERSION" });
  assert.equal(relay.stats.joins, 0, "the old guest took no seat");
  // Another game keeps taking every version.
  const port = await host(url, "pb94-port", "0.0.1");
  port.h.close();
  h.close();
});

test("the oldest version or newer is in, and the room and welcome name the oldest", async (t) => {
  const { url } = await start(t, { oldest: { "sundown-run": "0.6.0" } });
  const h = client(`${url}/v1/host?game=sundown-run&ver=0.6.0`);
  const room = await h.next();
  assert.deepEqual(room, { op: "room", code: room.code, oldest: "0.6.0" });
  const { g, msg } = await join(url, room.code, "sundown-run", "0.6.10");
  assert.deepEqual(msg, { op: "welcome", you: 0, ver: "0.6.0", oldest: "0.6.0" });
  assert.deepEqual(await h.next(), { op: "joined", guest: 0, ver: "0.6.10" });
  g.close();
  h.close();
});

test("a game that sends no version is let in, an oldest set or not", async (t) => {
  const { url } = await start(t, { oldest: { "sundown-run": "0.6.0" } });
  const h = client(`${url}/v1/host?game=sundown-run`);
  const room = await h.next();
  assert.equal(room.op, "room");
  const g = client(`${url}/v1/join?game=sundown-run&code=${room.code}`);
  assert.deepEqual(await g.next(), { op: "welcome", you: 0, ver: "", oldest: "0.6.0" });
  g.close();
  h.close();
  // With no oldest at all (the default), nothing changes: no "oldest" field, any version in.
  const plain = await start(t);
  const p = await host(plain.url, "sundown-run", "0.0.1");
  assert.deepEqual((await join(plain.url, p.code, "sundown-run", "0.0.1")).msg, { op: "welcome", you: 0, ver: "0.0.1" });
  p.h.close();
});

test("a full room, a wrong code and a wrong game are refused", async (t) => {
  const { url } = await start(t);
  const { h, code } = await host(url);
  await join(url, code);
  assert.deepEqual((await join(url, code)).msg, { op: "error", reason: "ROOM FULL" });
  assert.deepEqual((await join(url, "ZZZZ")).msg, { op: "error", reason: "NO SUCH ROOM" });
  // Each game has its own codes.
  assert.deepEqual((await join(url, code, "pb94-vr")).msg, { op: "error", reason: "NO SUCH ROOM" });
  const bad = client(`${url}/v1/host?game=chess`);
  assert.deepEqual(await bad.next(), { op: "error", reason: "NO SUCH GAME" });
  h.close();
});

test("a guest leaving tells the host, and its seat opens", async (t) => {
  const { url } = await start(t);
  const { h, code } = await host(url);
  const { g } = await join(url, code);
  await h.next();
  g.close();
  assert.deepEqual(await h.next(), { op: "left", guest: 0 });
  assert.equal((await join(url, code)).msg.op, "welcome");
  h.close();
});

test("the host leaving closes the room and its guests", async (t) => {
  const { url, relay } = await start(t);
  const { h, code } = await host(url);
  const { g } = await join(url, code);
  h.close();
  assert.deepEqual(await g.next(), { op: "error", reason: "HOST LEFT" });
  await g.closed;
  assert.equal(relay.rooms.size, 0);
});

test("a 1 MiB message gets through, a bigger one closes the sender", async (t) => {
  const { url } = await start(t);
  const { h, code } = await host(url);
  const { g } = await join(url, code);
  await h.next();
  const big = Buffer.alloc((1 << 20) - 1, 5);
  g.send(big);
  const got = await h.next();
  assert.equal(got.length, 1 << 20);
  assert.equal(got[0], 0);
  g.send(Buffer.alloc((1 << 20) + 1));
  assert.equal(await g.closed, 1009);
  h.close();
});

test("too many messages a second close the connection", async (t) => {
  const { url } = await start(t, { ratePerSec: 20 });
  const { h, code } = await host(url);
  const { g } = await join(url, code);
  await h.next();
  for (let i = 0; i < 40; i++) g.send(Buffer.from([i]));
  assert.equal(await g.closed, 1008);
  h.close();
});

test("an address can open only so many rooms a minute", async (t) => {
  const { url } = await start(t, { roomsPerMinute: 3 });
  const hosts = [];
  for (let i = 0; i < 3; i++) hosts.push((await host(url, "pb94-port", "1", { "x-forwarded-for": "203.0.113.5" })).h);
  const fourth = client(`${url}/v1/host?game=pb94-port`, { "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
  assert.deepEqual(await fourth.next(), { op: "error", reason: "TOO MANY ROOMS" });
  hosts.push((await host(url, "pb94-port", "1", { "x-forwarded-for": "198.51.100.7" })).h);
  hosts.forEach((h) => h.close());
});

test("an address that tries too many wrong rooms waits", async (t) => {
  const { url, port } = await start(t, { missesPerMinute: 3 });
  const { h, code } = await host(url, "pb94-vr-coach");
  h.send(JSON.stringify({ op: "page", html: "<p>COACH</p>" }));
  const me = { "x-forwarded-for": "203.0.113.9" };
  assert.equal((await get(port, "/c/ZZZZ", me)).status, 404);
  assert.equal((await join(url, "ZZZZ", "pb94-vr-coach", "1", me)).msg.reason, "NO SUCH ROOM");
  assert.equal((await get(port, "/c/ZZZX", me)).status, 404);
  // Three misses: now even the right room waits, by page or by socket.
  assert.deepEqual(await get(port, `/c/${code}`, me), { status: 429, body: "TOO MANY TRIES" });
  assert.equal((await join(url, code, "pb94-vr-coach", "1", me)).msg.reason, "TOO MANY TRIES");
  // Another address is fine.
  assert.equal((await get(port, `/c/${code}`, { "x-forwarded-for": "198.51.100.7" })).status, 200);
  h.close();
});

test("the relay holds only so many connections", async (t) => {
  const { url } = await start(t, { maxConnections: 2 });
  const { h, code } = await host(url, "pb94-vr-coach");
  await join(url, code, "pb94-vr-coach");
  assert.deepEqual((await join(url, code, "pb94-vr-coach")).msg, { op: "error", reason: "SERVER FULL" });
  h.close();
});

test("a quiet room ends", async (t) => {
  const { url } = await start(t, { idleMs: 100, sweepMs: 50 });
  const { h } = await host(url);
  assert.deepEqual(await h.next(), { op: "error", reason: "IDLE" });
});

test("a VR coach room serves the page its headset sent", async (t) => {
  const { url, port } = await start(t);
  const { h, code } = await host(url, "pb94-vr-coach");
  assert.equal((await get(port, `/c/${code}`)).status, 404);
  h.send(JSON.stringify({ op: "page", html: "<p>COACH</p>" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await get(port, `/c/${code}`), { status: 200, body: "<p>COACH</p>" });
  assert.equal((await get(port, `/c/${code.toLowerCase()}`)).status, 200, "any case");
  // Other games' rooms can't serve pages.
  const port_ = await host(url, "pb94-port");
  port_.h.send(JSON.stringify({ op: "page", html: "x" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await get(port, `/c/${port_.code}`)).status, 404);
  h.close();
  port_.h.close();
});

// --- Boards (port kit PORT-158/159) ------------------------------------------------

const { current, isoWeek } = require("../boards");

async function board(port, name, method = "GET", body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/board?game=pb94-port&board=${name}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json(), headers: res.headers };
}

function today(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return `trip-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

test("a day's board takes scores, best first, one per address and initials", async (t) => {
  const { port } = await start(t);
  const name = today();
  assert.deepEqual((await board(port, name)).body, { board: [], count: 0 });
  let r = await board(port, name, "POST", { initials: "ACE", score: 500, detail: "LEG 3" });
  assert.equal(r.status, 200);
  assert.equal(r.body.rank, 1);
  r = await board(port, name, "POST", { initials: "BOB", score: 900, detail: "WON" }, { "x-forwarded-for": "10.0.0.2" });
  assert.equal(r.body.rank, 1);
  r = await board(port, name, "POST", { initials: "ACE", score: 400 });
  assert.equal(r.body.kept, false, "a worse score doesn't replace a better");
  r = await board(port, name, "POST", { initials: "ACE", score: 1000, detail: "WON 9-1" });
  assert.equal(r.body.rank, 1, "a better one does");
  const b = (await board(port, name)).body;
  assert.equal(b.count, 2);
  assert.deepEqual(b.board.map((e) => e.initials), ["ACE", "BOB"]);
  assert.equal(b.board[0].detail, "WON 9-1");
  assert.equal(b.board[0].ip, undefined, "addresses never leave the relay");
});

test("a board refuses what it shouldn't keep", async (t) => {
  const { port } = await start(t);
  for (const [entry, why] of [[{ initials: "ab", score: 1 }, "BAD INITIALS"], [{ initials: "ASS", score: 1 }, "BAD INITIALS"],
    [{ initials: "ACE", score: -1 }, "BAD SCORE"], [{ initials: "ACE", score: 1.5 }, "BAD SCORE"],
    [{ initials: "ACE", score: 1, detail: "lower case" }, "BAD DETAIL"]]) {
    const r = await board(port, today(), "POST", entry, { "x-forwarded-for": "10.9.9." + why.length });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, why);
  }
  const old = await board(port, today(-5), "POST", { initials: "ACE", score: 1 });
  assert.equal(old.body.error, "NOT TODAY");
  const odd = await board(port, "trip-x", "POST", { initials: "ACE", score: 1 });
  assert.equal(odd.body.error, "NOT TODAY");
  const game = await fetch(`http://127.0.0.1:${port}/v1/board?game=nope&board=${today()}`);
  assert.equal(game.status, 404);
});

test("an address can post only so many scores a minute", async (t) => {
  const { port } = await start(t);
  let last;
  for (let i = 0; i < 7; i++) last = await board(port, today(), "POST", { initials: "ACE", score: i });
  assert.equal(last.status, 429);
});

test("boards answer any page (CORS), preflight too", async (t) => {
  const { port } = await start(t);
  const pre = await board(port, today(), "OPTIONS");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
});

test("weeks: this one and the last are taken", () => {
  const now = new Date(Date.UTC(2026, 10, 11));         // a Wednesday
  assert.deepEqual(isoWeek(now), [2026, 46]);
  assert.deepEqual(isoWeek(new Date(Date.UTC(2027, 0, 1))), [2026, 53]);
  assert.ok(current("week-202646", now));
  assert.ok(current("week-202645", now));
  assert.ok(!current("week-202644", now));
  assert.ok(current("trip-20261110", now) && current("trip-20261112", now) && !current("trip-20261113", now));
});

test("BOARD_FILE keeps boards across a restart", async (t) => {
  const file = require("path").join(require("os").tmpdir(), `boards-${process.pid}.json`);
  t.after(() => require("fs").rmSync(file, { force: true }));
  const first = await start(t, { boardFile: file });
  await board(first.port, today(), "POST", { initials: "ACE", score: 77 });
  await new Promise((r) => setTimeout(r, 1300));
  const second = await start(t, { boardFile: file });
  assert.equal((await board(second.port, today())).body.board[0].score, 77);
});
