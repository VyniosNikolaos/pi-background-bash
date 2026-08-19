import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { laneInstancesDir, laneLanesDir, laneRoot, laneSessionDir, sanitizeLaneName, stableSessionKey } from "./runtime.js";

export { laneInstancesDir, laneLanesDir, laneRoot, laneSessionDir, sanitizeLaneName, stableSessionKey } from "./runtime.js";

type LaneState = {
  schemaVersion: 1;
  name: string;
  sessionKey: string;
  baseLeafId: string | null;
  headEntryId: string | null;
  headEpoch: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
};

type LockOwner = {
  schemaVersion: 1;
  lane: string;
  ownerInstanceId: string;
  pid: number;
  leaseEpoch: number;
  status: "active";
  acquiredAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  expectedHeadEntryId: string | null;
};

type InstanceState = {
  instanceId: string;
  pid: number;
  lane: string;
  status: "idle" | "waiting" | "active" | "disconnected";
  sessionId: string | null;
  sessionKey: string;
  sessionFile: string;
  leafId: string | null;
  startedAt: string;
  lastSeenAt: string;
};

type LockRelease = () => void;

type SessionManagerLike = {
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string | undefined;
  getLeafId?: () => string | null | undefined;
  getBranch?: () => unknown[];
  setSessionFile?: (path: string) => void;
  branch?: (entryId: string) => void;
  resetLeaf?: () => void;
};

type ExtensionContextLike = {
  cwd?: string;
  sessionManager?: SessionManagerLike;
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

type InputEventLike = { source?: string; text?: string };
type SessionTreeEventLike = { newLeafId?: string | null; oldLeafId?: string | null };

const DEFAULT_LANE = "main";
const LOCK_STALE_MS = Number(process.env.PI_LANE_LOCK_STALE_MS ?? 10 * 60_000);
const HEARTBEAT_MS = Number(process.env.PI_LANE_HEARTBEAT_MS ?? 2_000);
const LEASE_TTL_MS = Number(process.env.PI_LANE_LEASE_TTL_MS ?? 10 * 60_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function rootDir(ctx?: ExtensionContextLike): string {
  return laneRoot();
}

function sessionFile(ctx: ExtensionContextLike): string | undefined {
  return ctx.sessionManager?.getSessionFile?.();
}

function sessionKey(ctx: ExtensionContextLike, file: string): string {
  return stableSessionKey(file, ctx.sessionManager?.getSessionId?.());
}

function sessionDir(ctx: ExtensionContextLike, file: string): string {
  return laneSessionDir(rootDir(ctx), sessionKey(ctx, file));
}

function lanesDir(ctx: ExtensionContextLike, file: string): string {
  return laneLanesDir(rootDir(ctx), sessionKey(ctx, file));
}

function instancesDir(ctx: ExtensionContextLike, file: string): string {
  return laneInstancesDir(rootDir(ctx), sessionKey(ctx, file));
}

function instancePath(ctx: ExtensionContextLike, file: string, instanceId: string): string {
  return join(instancesDir(ctx, file), `${instanceId}.json`);
}

function debugLogPath(ctx: ExtensionContextLike, file: string): string {
  return join(sessionDir(ctx, file), "debug.jsonl");
}

function lanePath(ctx: ExtensionContextLike, file: string, lane: string): string {
  return join(lanesDir(ctx, file), `${sanitizeLaneName(lane)}.json`);
}

function lockDir(ctx: ExtensionContextLike, file: string, lane: string): string {
  return join(lanesDir(ctx, file), `${sanitizeLaneName(lane)}.lock`);
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function appendDebug(ctx: ExtensionContextLike, file: string, event: string, data: Record<string, unknown> = {}): void {
  mkdirSync(sessionDir(ctx, file), { recursive: true });
  writeFileSync(
    debugLogPath(ctx, file),
    `${JSON.stringify({ at: nowIso(), event, ...data })}\n`,
    { flag: "a" },
  );
}

function persistedLeafId(file: string): string | null {
  const entries = readSessionEntryRecords(file).filter((entry) => entry.type !== "session" && entry.id);
  return entries.at(-1)?.id ?? null;
}

function ensureLane(ctx: ExtensionContextLike, file: string, lane: string, baseLeafId: string | null): LaneState {
  const name = sanitizeLaneName(lane);
  const path = lanePath(ctx, file, name);
  const existing = readJsonFile<LaneState>(path);
  if (existing) return existing;

  const created: LaneState = {
    schemaVersion: 1,
    name,
    sessionKey: sessionKey(ctx, file),
    baseLeafId,
    headEntryId: baseLeafId,
    headEpoch: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeJsonFile(path, created);
  return created;
}

function updateLane(ctx: ExtensionContextLike, file: string, lane: string, patch: Partial<LaneState>): LaneState {
  const current = ensureLane(ctx, file, lane, ctx.sessionManager?.getLeafId?.() ?? null);
  const next = { ...current, ...patch, schemaVersion: 1 as const, name: sanitizeLaneName(lane), updatedAt: nowIso() };
  writeJsonFile(lanePath(ctx, file, lane), next);
  return next;
}

function lockOwnerPath(ctx: ExtensionContextLike, file: string, lane: string): string {
  return join(lockDir(ctx, file, lane), "owner.json");
}

function removeStaleLock(path: string): void {
  const owner = readJsonFile<{ expiresAt?: string; acquiredAt?: string }>(join(path, "owner.json"));
  if (!owner) {
    try {
      const ageMs = Date.now() - statSync(path).mtimeMs;
      if (ageMs < LOCK_STALE_MS) return;
    } catch {
      return;
    }
  }
  const expires = owner?.expiresAt ? Date.parse(owner.expiresAt) : Number.NaN;
  if (Number.isFinite(expires) && Date.now() <= expires) return;
  const acquired = owner?.acquiredAt ? Date.parse(owner.acquiredAt) : Number.NaN;
  if (!Number.isFinite(expires) && Number.isFinite(acquired) && Date.now() - acquired < LOCK_STALE_MS) return;
  rmSync(path, { recursive: true, force: true });
}

async function acquireLock(ctx: ExtensionContextLike, file: string, lane: string, instanceId: string): Promise<LockRelease> {
  const path = lockDir(ctx, file, lane);
  for (;;) {
    try {
      mkdirSync(path, { recursive: false });
      const laneState = ensureLane(ctx, file, lane, ctx.sessionManager?.getLeafId?.() ?? null);
      const acquiredAt = Date.now();
      const owner: LockOwner = {
        schemaVersion: 1,
        lane: sanitizeLaneName(lane),
        ownerInstanceId: instanceId,
        pid: process.pid,
        leaseEpoch: laneState.headEpoch + 1,
        status: "active",
        acquiredAt: new Date(acquiredAt).toISOString(),
        lastHeartbeatAt: new Date(acquiredAt).toISOString(),
        expiresAt: new Date(acquiredAt + LEASE_TTL_MS).toISOString(),
        expectedHeadEntryId: laneState.headEntryId,
      };
      writeJsonFile(join(path, "owner.json"), owner);
      appendDebug(ctx, file, "lock_acquired", { lane: sanitizeLaneName(lane), instanceId, leaseEpoch: owner.leaseEpoch, expectedHeadEntryId: owner.expectedHeadEntryId });
      return () => {
        rmSync(path, { recursive: true, force: true });
        appendDebug(ctx, file, "lock_released", { lane: sanitizeLaneName(lane), instanceId, leaseEpoch: owner.leaseEpoch });
      };
    } catch {
      appendDebug(ctx, file, "lock_wait", { lane: sanitizeLaneName(lane), instanceId });
      removeStaleLock(path);
      await sleep(25);
    }
  }
}

function reloadSession(ctx: ExtensionContextLike, file: string): void {
  ctx.sessionManager?.setSessionFile?.(file);
}

function moveToLaneHead(ctx: ExtensionContextLike, lane: LaneState): void {
  const target = lane.headEntryId ?? lane.baseLeafId;
  if (target) ctx.sessionManager?.branch?.(target);
  else ctx.sessionManager?.resetLeaf?.();
}

function readSessionEntryRecords(file: string): Array<Record<string, any>> {
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function updateLaneHeadAfterTurn(ctx: ExtensionContextLike, file: string, lane: string, newHeadEntryId: string | null): LaneState | undefined {
  const owner = readJsonFile<LockOwner>(lockOwnerPath(ctx, file, lane));
  const current = ensureLane(ctx, file, lane, ctx.sessionManager?.getLeafId?.() ?? null);
  if (!owner || owner.ownerInstanceId === undefined) {
    appendDebug(ctx, file, "head_update_skipped_missing_owner", { lane: sanitizeLaneName(lane), newHeadEntryId });
    return undefined;
  }
  if (current.headEntryId !== owner.expectedHeadEntryId) {
    appendDebug(ctx, file, "head_update_conflict", {
      lane: sanitizeLaneName(lane),
      expectedHeadEntryId: owner.expectedHeadEntryId,
      actualHeadEntryId: current.headEntryId,
      newHeadEntryId,
      leaseEpoch: owner.leaseEpoch,
    });
    return undefined;
  }
  return updateLane(ctx, file, lane, {
    headEntryId: newHeadEntryId,
    headEpoch: Math.max(current.headEpoch + 1, owner.leaseEpoch),
    updatedBy: owner.ownerInstanceId,
  });
}

export default function piLaneExtension(pi: any): void {
  const instanceId = randomUUID();
  let currentLane = DEFAULT_LANE;
  let activeRelease: LockRelease | undefined;
  let activeSessionFile: string | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let currentStatus: InstanceState["status"] = "idle";
  let currentSessionId: string | null | undefined;
  let currentSessionFile: string | undefined;
  let currentSessionKey: string | undefined;
  const startedAt = nowIso();
  const initialLaneRootEnv = process.env.PI_LANE_ROOT;

  function exportIdentity(ctx: ExtensionContextLike, file: string): void {
    const id = ctx.sessionManager?.getSessionId?.() ?? null;
    const key = stableSessionKey(file, id);
    currentSessionId = id;
    currentSessionFile = file;
    currentSessionKey = key;
    process.env.PI_LANE_INSTANCE_ID = instanceId;
    if (id) process.env.PI_LANE_SESSION_ID = id;
    else delete process.env.PI_LANE_SESSION_ID;
    process.env.PI_LANE_SESSION_KEY = key;
    process.env.PI_LANE_SESSION_FILE = file;
    process.env.PI_LANE_CURRENT_LANE = currentLane;
    process.env.PI_LANE_ROOT = rootDir(ctx);
  }

  function clearIdentity(): void {
    delete process.env.PI_LANE_INSTANCE_ID;
    delete process.env.PI_LANE_SESSION_ID;
    delete process.env.PI_LANE_SESSION_KEY;
    delete process.env.PI_LANE_SESSION_FILE;
    delete process.env.PI_LANE_CURRENT_LANE;
    if (initialLaneRootEnv === undefined) delete process.env.PI_LANE_ROOT;
    else process.env.PI_LANE_ROOT = initialLaneRootEnv;
  }

  function writeInstance(ctx: ExtensionContextLike, file: string, status = currentStatus): void {
    currentStatus = status;
    exportIdentity(ctx, file);
    const state: InstanceState = {
      instanceId,
      pid: process.pid,
      lane: currentLane,
      status,
      sessionId: currentSessionId ?? null,
      sessionKey: currentSessionKey!,
      sessionFile: file,
      leafId: ctx.sessionManager?.getLeafId?.() ?? null,
      startedAt,
      lastSeenAt: nowIso(),
    };
    writeJsonFile(instancePath(ctx, file, instanceId), state);
    if (status === "active") {
      const ownerPath = lockOwnerPath(ctx, file, currentLane);
      const owner = readJsonFile<LockOwner>(ownerPath);
      if (owner?.ownerInstanceId === instanceId) {
        const seen = Date.now();
        writeJsonFile(ownerPath, {
          ...owner,
          lastHeartbeatAt: new Date(seen).toISOString(),
          expiresAt: new Date(seen + LEASE_TTL_MS).toISOString(),
        });
      }
    }
  }

  function readInstances(ctx: ExtensionContextLike, file: string): InstanceState[] {
    mkdirSync(instancesDir(ctx, file), { recursive: true });
    return readdirSync(instancesDir(ctx, file))
      .filter((item) => item.endsWith(".json"))
      .map((item) => readJsonFile<InstanceState>(join(instancesDir(ctx, file), item)))
      .filter((item): item is InstanceState => !!item);
  }

  function notify(ctx: ExtensionContextLike, message: string): void {
    ctx.ui?.notify?.(message, "info");
  }

  pi.registerCommand("lane", {
    description: "Show, join, or create Pi lanes for synced session parallelism",
    handler: async (args: string, ctx: ExtensionContextLike) => {
      const file = sessionFile(ctx);
      if (!file) {
        notify(ctx, "pi-lane: no persisted session file");
        return;
      }

      const [rawCommand, rawName] = args.trim().split(/\s+/, 2);
      const command = rawCommand || "status";

      if (command === "new") {
        const name = sanitizeLaneName(rawName || `lane-${Date.now().toString(36)}`);
        // Preserve the currently selected tree leaf. Reloading here rebuilds the
        // session manager from disk and snaps back to the persisted tail, which
        // makes creating a lane from an older selected message branch from the
        // wrong node.
        const leaf = ctx.sessionManager?.getLeafId?.() ?? null;
        currentLane = name;
        ensureLane(ctx, file, name, leaf);
        writeInstance(ctx, file, "idle");
        notify(ctx, `pi-lane: created and joined lane ${name}`);
        return;
      }

      if (command === "join") {
        const name = sanitizeLaneName(rawName || DEFAULT_LANE);
        reloadSession(ctx, file);
        const lane = ensureLane(ctx, file, name, ctx.sessionManager?.getLeafId?.() ?? null);
        currentLane = name;
        moveToLaneHead(ctx, lane);
        writeInstance(ctx, file, "idle");
        notify(ctx, `pi-lane: joined lane ${name}`);
        return;
      }

      if (command === "list") {
        mkdirSync(lanesDir(ctx, file), { recursive: true });
        const names = readdirSync(lanesDir(ctx, file))
          .filter((item) => item.endsWith(".json"))
          .map((item) => item.replace(/\.json$/, ""))
          .sort();
        const instances = readInstances(ctx, file)
          .map((item) => `${item.lane}:${item.status}:${item.pid}`)
          .join(", ");
        notify(ctx, `pi-lane: lanes ${names.join(", ") || "main"}; current ${currentLane}; instances ${instances || "none"}`);
        return;
      }

      if (command === "instances") {
        const instances = readInstances(ctx, file)
          .map((item) => `${item.instanceId.slice(0, 8)} ${item.lane} ${item.status} pid=${item.pid} seen=${item.lastSeenAt}`)
          .join("; ");
        notify(ctx, `pi-lane: instances ${instances || "none"}`);
        return;
      }

      if (command === "identity" || command === "self") {
        exportIdentity(ctx, file);
        notify(ctx, `pi-lane: identity sessionId=${currentSessionId ?? "<none>"} sessionKey=${currentSessionKey} sessionFile=${currentSessionFile} instanceId=${instanceId} currentLane=${currentLane} root=${rootDir(ctx)} pid=${process.pid}`);
        return;
      }

      if (command === "debug") {
        notify(ctx, `pi-lane: debug log ${debugLogPath(ctx, file)}`);
        return;
      }

      if (command !== "status") {
        notify(ctx, `pi-lane: unknown command ${command}; try status, new, join, list, instances, identity, or debug`);
        return;
      }

      const lane = ensureLane(ctx, file, currentLane, ctx.sessionManager?.getLeafId?.() ?? null);
      const instances = readInstances(ctx, file).filter((item) => item.lane === currentLane);
      notify(ctx, `pi-lane: current ${lane.name}; head ${lane.headEntryId ?? "<empty>"}; connected ${instances.length}`);
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContextLike) => {
    const file = sessionFile(ctx);
    if (!file) {
      clearIdentity();
      return;
    }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    currentLane = DEFAULT_LANE;
    mkdirSync(lanesDir(ctx, file), { recursive: true });
    mkdirSync(instancesDir(ctx, file), { recursive: true });
    ensureLane(ctx, file, DEFAULT_LANE, persistedLeafId(file));
    writeInstance(ctx, file, "idle");
    heartbeatTimer = setInterval(() => writeInstance(ctx, file), HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  });

  pi.on("input", async (event: InputEventLike, ctx: ExtensionContextLike) => {
    if (event.source === "extension") return { action: "continue" as const };

    const file = sessionFile(ctx);
    if (!file) return { action: "continue" as const };

    writeInstance(ctx, file, "waiting");
    activeRelease = await acquireLock(ctx, file, currentLane, instanceId);
    activeSessionFile = file;
    writeInstance(ctx, file, "active");

    reloadSession(ctx, file);
    const lane = ensureLane(ctx, file, currentLane, ctx.sessionManager?.getLeafId?.() ?? null);
    moveToLaneHead(ctx, lane);

    return { action: "continue" as const };
  });

  pi.on("agent_end", async (_event: unknown, ctx: ExtensionContextLike) => {
    const file = activeSessionFile ?? sessionFile(ctx);
    if (file) {
      updateLaneHeadAfterTurn(ctx, file, currentLane, ctx.sessionManager?.getLeafId?.() ?? null);
    }
    activeRelease?.();
    activeRelease = undefined;
    activeSessionFile = undefined;
    if (file) writeInstance(ctx, file, "idle");
  });

  pi.on("session_tree", async (event: SessionTreeEventLike, ctx: ExtensionContextLike) => {
    const file = sessionFile(ctx);
    if (!file) return;
    // Do not reload here: Pi has already moved the active leaf before emitting
    // session_tree. Reloading would rebuild the manager from disk and snap the
    // UI back to the persisted tail, making Esc/tree navigation appear broken.
    const newHeadEntryId = event.newLeafId ?? ctx.sessionManager?.getLeafId?.() ?? null;
    const current = ensureLane(ctx, file, currentLane, ctx.sessionManager?.getLeafId?.() ?? null);
    updateLane(ctx, file, currentLane, {
      headEntryId: newHeadEntryId,
      headEpoch: current.headEpoch + 1,
      updatedBy: instanceId,
    });
    appendDebug(ctx, file, "tree_navigation_head_update", {
      lane: sanitizeLaneName(currentLane),
      oldLeafId: event.oldLeafId ?? null,
      newHeadEntryId,
      instanceId,
    });
    writeInstance(ctx, file, "idle");
  });

  pi.on("session_shutdown", async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (currentSessionFile && currentSessionKey) {
      writeJsonFile(join(rootDir(), "sessions", currentSessionKey, "instances", `${instanceId}.json`), {
        instanceId,
        pid: process.pid,
        lane: currentLane,
        sessionId: currentSessionId ?? null,
        sessionKey: currentSessionKey,
        sessionFile: currentSessionFile,
        leafId: null,
        startedAt,
        status: "disconnected",
        lastSeenAt: nowIso(),
      });
    }
    activeRelease?.();
    activeRelease = undefined;
    activeSessionFile = undefined;
    clearIdentity();
  });
}
