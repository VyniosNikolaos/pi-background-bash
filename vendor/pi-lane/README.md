# pi-lane

Live lane coordination for Pi sessions.

`pi-lane` makes the default same-session, multi-terminal behavior safe: multiple Pi runtimes attach to one live lane, wait their turn, refresh the session file, and extend the lane instead of accidentally creating parallel sibling branches from a stale leaf.

## Install

```bash
pi install npm:pi-lane
```

For full lane correctness, apply the companion Pi core patch via `../pi-patches`:

```bash
cd ../pi-patches
bash apply.sh
bash test.sh
```

The patch refreshes Pi's agent transcript after `input` hooks, so pi-lane can move a runtime to the current lane head before the model request is built without injecting hidden context.

## Default behavior

No command is required. Every persisted Pi session gets a default lane named `main`.

When two Pi instances submit prompts against the same session at the same time, `pi-lane` serializes the turns and makes the second runtime attach to the path produced by the first runtime. Lane metadata is not injected into model context.

`pi-lane` also writes durable instance heartbeat files so you can see which runtimes are connected to each lane. Each heartbeat includes the Pi `sessionId`, `sessionKey`, `sessionFile`, lane, PID, status, and stable `instanceId`.

For child tools and companion CLIs, `pi-lane` exports the active runtime identity into the Pi process environment before turns run:

```text
PI_LANE_INSTANCE_ID
PI_LANE_SESSION_ID
PI_LANE_SESSION_KEY
PI_LANE_SESSION_FILE
PI_LANE_CURRENT_LANE
PI_LANE_ROOT
```

Bash/tool subprocesses inherit these variables, so companion CLIs can discover the current Pi runtime without duplicating pi-lane identity logic.

## `pil` CLI

`pi-lane` installs `pil`, a small CLI for lane/runtime introspection that companion tools can reuse instead of duplicating heartbeat and liveness logic.

```bash
pil self
pil instances
pil lanes
pil status
```

Use `--json` for machine-readable output.

## Commands

```text
/lane              Show current lane
/lane new [name]   Create and join a new live lane from the current point
/lane join [name]  Join a lane (defaults to main)
/lane list         List lanes and compact instance status
/lane instances    Show connected instances for this session
/lane identity     Show this runtime's session/lane identity
/lane self         Alias for /lane identity
/lane debug        Show the debug log path
```

## Terminology

- **leaf**: an actual persisted session entry.
- **lane**: an intended live path from a leaf, created before the next leaf exists.
- **attach**: join an existing lane so new turns extend that lane.

## Architecture invariants

- Pi's session JSONL DAG is the source of truth.
- Lane metadata is only a cursor for where a live lane intends to continue.
- `pi-lane` must never rewrite session history from lane metadata.
- Lane heads move only from explicit lifecycle events: turn completion, tree navigation, session replacement/fork initialization, or an explicit lane command.

## Runtime files

By default state lives under:

```text
~/.pi/lane/sessions/{sessionKey}/
  lanes/{lane}.json              lane head + headEpoch
  lanes/{lane}.lock/owner.json   active lease owner + leaseEpoch + expectedHeadEntryId
  instances/{instanceId}.json    connected runtime heartbeat/discovery
  debug.jsonl                    lock/recovery/tree-navigation events
```

Set `PI_LANE_ROOT` to override the root, useful for tests.

The lock is only for lane turn ownership: it prevents two runtimes from extending the same live lane at once. Instance heartbeat files are separate and durable.

## Runtime helpers

Companion tools can import shared path/identity helpers instead of reimplementing pi-lane logic:

```js
import {
  stableSessionKey,
  sanitizeLaneName,
  laneRoot,
  laneSessionDir,
  laneInstancesDir,
} from "pi-lane/runtime";
```

## Status

The core session-parallelism problem is covered by pi-mock tests:

- `test/session-parallelism.test.mjs` proves the bug without `pi-lane`.
- `test/pi-lane.test.mjs` proves synced linear lane behavior with `pi-lane`, tree navigation and session replacement behavior, reusable runtime helpers, inherited identity env vars for bash children, durable instance discovery, simple commands, stale-lock crash recovery, ownerless-lock acquisition race handling, a real SIGKILL recovery path, epoch-tracked lane heads, no public repair/reconcile mutation commands, corrupt instance/lane-file tolerance, session isolation, and explicit lane creation.
