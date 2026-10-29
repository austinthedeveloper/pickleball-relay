// Two fake games over a local relay: rooms, codes, fan-out, limits.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { createRelay, ALPHABET, ALL } = require("../server");

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

async function join(url, code, game = "pb94-port", ver = "1.0.0") {
  const g = client(`${url}/v1/join?game=${game}&code=${code}&ver=${ver}`);
  return { g, msg: await g.next() };
}

function get(port, path) {
  return fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => ({ status: r.status, body: await r.text() }));
}

test("healthz says ok", async (t) => {
  const { port } = await start(t);
  assert.deepEqual(await get(port, "/healthz"), { status: 200, body: "ok" });
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
  // Other games' rooms can't serve pages.
  const port_ = await host(url, "pb94-port");
  port_.h.send(JSON.stringify({ op: "page", html: "x" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await get(port, `/c/${port_.code}`)).status, 404);
  h.close();
  port_.h.close();
});
