---
name: pil
description: Inspect Pi lane runtime identity, lanes, and live instances. Use when checking current Pi session/lane identity, debugging same-session multi-terminal coordination, or deciding whether another Pi runtime is live/stale.
---

# pil — Pi lane inspector

Use `pil` for generic Pi lane/session/runtime introspection. Use `pbb` only for background bash jobs.

## Commands

```bash
pil self
pil status
pil instances
pil lanes
```

Use JSON when programmatic parsing is needed:

```bash
pil self --json
pil instances --json
pil status --json
```

## Agent guidelines

- Use `pil self` to verify the current Pi runtime identity: session id, session key, session file, instance id, lane, and lane root.
- Use `pil instances` to see live/stale Pi runtimes attached to the same lane session.
- Use `pil lanes` or `pil status` to inspect lane heads and instance liveness.
- Do not use `pil` for background bash logs or process control; use `pbb` for that.
- Treat stale/disconnected instances as coordination warnings, not as current-agent state.
