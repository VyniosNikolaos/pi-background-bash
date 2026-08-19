#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_LANE = "main";

function stableSessionKey(sessionFile, sessionId) {
  return createHash("sha256").update(`${sessionId || "no-session-id"}\n${sessionFile}`).digest("hex").slice(0, 24);
}

function laneRoot() {
  return process.env.PI_LANE_ROOT || join(homedir(), ".pi", "lane");
}

function identity() {
  const sessionId = process.env.PI_LANE_SESSION_ID || "";
  const sessionFile = process.env.PI_LANE_SESSION_FILE || "";
  const sessionKey = process.env.PI_LANE_SESSION_KEY || (sessionFile ? stableSessionKey(sessionFile, sessionId) : "");
  return {
    sessionId,
    sessionKey,
    sessionFile,
    instanceId: process.env.PI_LANE_INSTANCE_ID || "",
    lane: process.env.PI_LANE_CURRENT_LANE || DEFAULT_LANE,
    root: laneRoot(),
  };
}

function sessionDir(id) {
  return join(id.root, "sessions", id.sessionKey);
}

function instancesDir(id) {
  return join(sessionDir(id), "instances");
}

function lanesDir(id) {
  return join(sessionDir(id), "lanes");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function attr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

function escapeBody(value) {
  return String(value ?? "").replace(/<\/pi_context>/gi, "<\\/pi_context>");
}

function context(kind, attrs, body) {
  const renderedAttrs = Object.entries({ source: "pil", kind, schema_version: SCHEMA_VERSION, ...attrs })
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => `${key}="${attr(value)}"`)
    .join(" ");
  return `<pi_context ${renderedAttrs}>\n${escapeBody(body)}\n</pi_context>`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--stale-ms") out.staleMs = Number(argv[++i]);
    else out._.push(arg);
  }
  return out;
}

function instanceLiveness(state, staleMs) {
  const lastSeenAt = state?.lastSeenAt || state?.updatedAt || "";
  const ageMs = lastSeenAt ? Date.now() - Date.parse(lastSeenAt) : undefined;
  const live = Boolean(state && state.status !== "disconnected" && ageMs !== undefined && Number.isFinite(ageMs) && ageMs <= staleMs);
  return {
    live,
    stale: !live,
    lastSeenAt,
    lastSeenAgeMs: ageMs,
    status: state?.status || "unknown",
  };
}

function listInstances(id, opts) {
  const staleMs = opts.staleMs || Number(process.env.PI_LANE_INSTANCE_STALE_MS || process.env.PBB_INSTANCE_STALE_MS || 15_000);
  const dir = instancesDir(id);
  if (!id.sessionKey || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((item) => item.endsWith(".json"))
    .map((item) => readJson(join(dir, item)))
    .filter(Boolean)
    .map((state) => ({ ...state, ...instanceLiveness(state, staleMs) }))
    .sort((a, b) => String(a.instanceId).localeCompare(String(b.instanceId)));
}

function listLanes(id) {
  const dir = lanesDir(id);
  if (!id.sessionKey || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((item) => item.endsWith(".json"))
    .map((item) => readJson(join(dir, item)))
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function print(value, opts, kind, id, summary, body) {
  if (opts.json) return console.log(JSON.stringify(value, null, 2));
  console.log(context(kind, { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane }, `<summary>${summary}</summary>\n${body}`));
}

const opts = parseArgs(process.argv.slice(2));
const command = opts._[0] || "status";
const id = identity();

if (["help", "--help", "-h"].includes(command)) {
  console.log(`pil - Pi lane inspector\n\nCommands:\n  pil self [--json]\n  pil instances [--json]\n  pil lanes [--json]\n  pil status [--json]\n\nUses PI_LANE_* env vars from pi-lane.`);
  process.exit(0);
}

if (command === "self" || command === "whoami") {
  const value = { kind: "pil.self", schemaVersion: SCHEMA_VERSION, ...id };
  print(value, opts, "pil.self", id, "current Pi lane identity", JSON.stringify(value, null, 2));
} else if (command === "instances") {
  const instances = listInstances(id, opts);
  const value = { kind: "pil.instances", schemaVersion: SCHEMA_VERSION, ...id, instances };
  print(value, opts, "pil.instances", id, `${instances.length} lane instances`, instances.map((item) => `- instance=${item.instanceId} live=${item.live} status=${item.status} lane=${item.lane || ""} last_seen=${item.lastSeenAt || "unknown"}`).join("\n") || "No lane instances.");
} else if (command === "lanes") {
  const lanes = listLanes(id);
  const value = { kind: "pil.lanes", schemaVersion: SCHEMA_VERSION, ...id, lanes };
  print(value, opts, "pil.lanes", id, `${lanes.length} lanes`, lanes.map((lane) => `- lane=${lane.name} head=${lane.headEntryId || "<empty>"} epoch=${lane.headEpoch}`).join("\n") || "No lanes.");
} else if (command === "status") {
  const instances = listInstances(id, opts);
  const lanes = listLanes(id);
  const value = { kind: "pil.status", schemaVersion: SCHEMA_VERSION, ...id, instances, lanes };
  print(value, opts, "pil.status", id, `${lanes.length} lanes; ${instances.length} instances`, `lanes:\n${lanes.map((lane) => `- lane=${lane.name} head=${lane.headEntryId || "<empty>"} epoch=${lane.headEpoch}`).join("\n") || "none"}\ninstances:\n${instances.map((item) => `- instance=${item.instanceId} live=${item.live} status=${item.status} lane=${item.lane || ""}`).join("\n") || "none"}`);
} else {
  console.error(`Unknown pil command: ${command}`);
  process.exit(2);
}
