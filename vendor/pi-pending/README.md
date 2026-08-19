# pi-pending

Tiny Pi TUI helper for one shared table of one-line pending jobs above the editor.

Use `pi-pending` from Pi extensions that start background jobs, multi-model requests, long-running tasks, or any asynchronous operation that should stay visible while the agent continues working.

```ts
import { createPiPending } from "pi-pending";

const pending = createPiPending({ namespace: "zcouncil" });

pi.on("session_start", (_event, ctx) => {
  if (ctx.hasUI) pending.attach(ctx.ui);
});

pending.start({
  id: "job_1",
  label: "Claude",
  text: "roast this architecture plan",
  details: { timeoutMs: 120_000 },
});

pending.finish("job_1");
```

Default visible row:

```txt
4m 16s job_1 Claude: roast this architecture plan
```

Ids are shown by default so users can copy the debug handle:

```ts
const pending = createPiPending({
  namespace: "background-bash",
  format: (job) => `$ ${job.text}`,
});
```

```txt
4m 16s bg_12 $ cd ../pi-stat422 && python3 scripts/run_benchmark.py
```

Set `showId: false` to hide ids, or `showId: "auto"` to show ids only for
unlabeled items. Use `minElapsedColumnWidth` and `minIdColumnWidth` to keep
columns stable across multi-row widgets.

All `createPiPending(...)` registries in the same Pi runtime render into one shared `pi-pending` table. Do not create per-extension widget ids; `widgetId` is deprecated and ignored.

Details stay in metadata. Rows are always normalized to one terminal line,
truncated to width, padded to width, and styled with Pi's `toolPendingBg` +
`toolTitle` theme colors.

## Install

Use as a GitHub dependency from another Pi package:

```json
{
  "dependencies": {
    "pi-pending": "github:sshkeda/pi-pending#v0.1.5"
  }
}
```

## Development

```bash
npm install
npm test
```

## License

MIT
