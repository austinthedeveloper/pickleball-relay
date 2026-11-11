// Replay codes (port kit PORT-157, port ADR-112): a saved rally shared as a
// six-letter code, watched on any game with the code.
//
//   POST /v1/replay?game=pb94-port   {"data":"<base64>"}  -> {"code":"BXKMQT","days":7}
//   GET  /v1/replay?game=pb94-port&code=BXKMQT            -> {"data":"<base64>"} (404 NO SUCH REPLAY)
//
// What's kept: the replay's bytes (the game's inputs and match settings for
// one rally: no names, no accounts) and when it came, for 7 days, under a
// random code. The sender's address is used for the rate limit only and
// never stored with a replay. Replays live in memory and, if REPLAY_FILE is
// set, in that file too (a sleeping relay forgets otherwise).
"use strict";

const fs = require("fs");
const crypto = require("crypto");

const DAYS = 7;
const MAX_BYTES = 48 * 1024;            // a rally's replay is a few KB
const MAX_REPLAYS = 5000;
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // the rooms' letters: no vowels, so no words
const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{6}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function newCode(taken) {
  for (let i = 0; i < 50; i++) {
    let c = "";
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) c += ALPHABET[b % ALPHABET.length];
    if (!taken.has(c)) return c;
  }
  return "";
}

function createReplays(options = {}) {
  const file = options.file || "";
  const perHour = options.perHour || 20;
  const keepMs = (options.days || DAYS) * 86400000;
  const replays = new Map();            // "game/code" -> {data, at}
  const shares = new Map();             // ip -> [times], for the rate limit only
  let dirty = null;

  if (file && fs.existsSync(file)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) replays.set(k, v);
    } catch {
      // a broken file starts empty
    }
  }

  function persist() {
    if (!file || dirty) return;
    dirty = setTimeout(() => {
      dirty = null;
      try {
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries(replays)));
      } catch {
        // the next change tries again
      }
    }, 1000);
    if (dirty.unref) dirty.unref();
  }

  function share(game, body, ip, now = Date.now()) {
    if (!body || typeof body.data !== "string" || !B64.test(body.data)) return { error: "BAD REPLAY" };
    if (Buffer.byteLength(body.data) > MAX_BYTES) return { error: "TOO BIG" };
    const times = (shares.get(ip) || []).filter((t) => now - t < 3600000);
    if (times.length >= perHour) return { error: "TOO MANY TRIES" };
    times.push(now);
    shares.set(ip, times);
    sweep(now);
    if (replays.size >= MAX_REPLAYS) return { error: "FULL" };
    const taken = new Set([...replays.keys()].map((k) => k.slice(game.length + 1)));
    const code = newCode(taken);
    if (!code) return { error: "FULL" };
    replays.set(game + "/" + code, { data: body.data, at: now });
    persist();
    return { code, days: DAYS };
  }

  function get(game, code, now = Date.now()) {
    if (!CODE.test(code)) return null;
    const r = replays.get(game + "/" + code);
    if (!r || now - r.at > keepMs) return null;
    return { data: r.data };
  }

  function sweep(now = Date.now()) {
    let gone = false;
    for (const [k, r] of replays) {
      if (now - r.at > keepMs) {
        replays.delete(k);
        gone = true;
      }
    }
    for (const [ip, times] of shares) {
      if (!times.some((t) => now - t < 3600000)) shares.delete(ip);
    }
    if (gone) persist();
  }

  return { share, get, sweep, size: () => replays.size };
}

module.exports = { createReplays, CODE, MAX_BYTES, DAYS };
