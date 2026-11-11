// Score boards (port kit PORT-158/159, port ADR-109): TODAY'S TRIP's board
// for each day and the weekly challenge's for each week.
//
//   GET  /v1/board?game=pb94-port&board=trip-20261111          -> {"board":[...],"count":n}
//   POST /v1/board?game=pb94-port&board=trip-20261111
//        {"initials":"ACE","score":1240,"detail":"WON 9-2"}    -> {"ok":true,"rank":3,"board":[...]}
//
// A board keeps its top entries, one per address and initials (a better
// score replaces a worse). Only a board for a day or week near today's is
// taken. Initials are three letters, never one of a short list of words.
// The scores are the game's own claim: the relay can't replay a trip, so a
// board is for friends, not prizes (ADR-109). Boards live in memory and, if
// BOARD_FILE is set, in that file too (the relay sleeps when idle, and a
// sleeping relay forgets).
"use strict";

const fs = require("fs");

const KEEP = 20;                        // entries a board shows
const MAX_SCORE = 1000000;
const DETAIL = /^[A-Z0-9 !?.,:\-'/%+]{0,24}$/;
const BOARD = /^(trip-(\d{8})|week-(\d{4})(\d{2}))$/;
const BLOCKED = new Set(["ASS", "FUK", "FCK", "SEX", "TIT", "CUM", "FAG", "NIG", "KKK", "DIK", "DIC",
  "COK", "JIZ", "WTF", "STD", "POO", "PEE", "GAY", "NAZ", "HIV"]);

function utcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// The ISO week of a date: [year, week].
function isoWeek(date) {
  const d = new Date(utcDay(date));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const year = d.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return [year, week];
}

// A board's name is near enough to today: a day within one either way (time
// zones), or this week or the last.
function current(name, now = new Date()) {
  const m = BOARD.exec(name);
  if (!m) return false;
  if (m[2]) {
    const s = m[2];
    const t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    return Math.abs(t - utcDay(now)) <= 86400000;
  }
  const [y, w] = isoWeek(now);
  const [py, pw] = isoWeek(new Date(now.getTime() - 7 * 86400000));
  const by = +m[3];
  const bw = +m[4];
  return (by === y && bw === w) || (by === py && bw === pw);
}

function valid(entry) {
  if (!entry || typeof entry !== "object") return "BAD ENTRY";
  if (typeof entry.initials !== "string" || !/^[A-Z]{3}$/.test(entry.initials)) return "BAD INITIALS";
  if (BLOCKED.has(entry.initials)) return "BAD INITIALS";
  if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > MAX_SCORE) return "BAD SCORE";
  if (entry.detail !== undefined && (typeof entry.detail !== "string" || !DETAIL.test(entry.detail))) return "BAD DETAIL";
  return "";
}

function createBoards(options = {}) {
  const file = options.file || "";
  const postsPerMinute = options.postsPerMinute || 6;
  const boards = new Map();               // "game/board" -> [{initials, score, detail, ip, at}]
  const posts = new Map();                // ip -> [times]
  let dirty = null;

  if (file && fs.existsSync(file)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) boards.set(k, v);
    } catch {
      // a broken file starts empty
    }
  }

  function save() {
    if (!file || dirty) return;
    dirty = setTimeout(() => {
      dirty = null;
      const out = {};
      const now = new Date();
      for (const [k, v] of boards) if (current(k.split("/")[1], now)) out[k] = v;
      fs.writeFile(file, JSON.stringify(out), () => {});
    }, 1000);
  }

  function shown(list) {
    return list.slice(0, KEEP).map((e) => ({ initials: e.initials, score: e.score, detail: e.detail || "" }));
  }

  function get(game, name) {
    const list = boards.get(game + "/" + name) || [];
    return { board: shown(list), count: list.length };
  }

  // A score posted from `ip`: kept if it's that address and initials' best.
  function post(game, name, entry, ip, now = new Date()) {
    if (!current(name, now)) return { error: "NOT TODAY" };
    const why = valid(entry);
    if (why) return { error: why };
    const times = (posts.get(ip) || []).filter((t) => now - t < 60000);
    if (times.length >= postsPerMinute) return { error: "TOO MANY TRIES" };
    times.push(now.getTime());
    posts.set(ip, times);
    const key = game + "/" + name;
    const list = boards.get(key) || [];
    const mine = list.findIndex((e) => e.ip === ip && e.initials === entry.initials);
    if (mine >= 0 && list[mine].score >= entry.score) {
      return { ok: true, rank: mine + 1, board: shown(list), kept: false };
    }
    if (mine >= 0) list.splice(mine, 1);
    const row = { initials: entry.initials, score: entry.score, detail: entry.detail || "", ip, at: now.getTime() };
    let at = list.findIndex((e) => e.score < row.score);
    if (at < 0) at = list.length;
    list.splice(at, 0, row);
    if (list.length > 200) list.length = 200;
    boards.set(key, list);
    save();
    return { ok: true, rank: at + 1, board: shown(list), kept: true };
  }

  function sweep(now = new Date()) {
    for (const k of [...boards.keys()]) if (!current(k.split("/")[1], now)) boards.delete(k);
    for (const [ip, times] of posts) if (times.every((t) => now - t > 60000)) posts.delete(ip);
  }

  return { get, post, sweep, boards };
}

module.exports = { createBoards, current, isoWeek, valid, KEEP };
