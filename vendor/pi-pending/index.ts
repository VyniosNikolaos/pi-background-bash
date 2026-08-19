import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PiPendingPlacement = "aboveEditor" | "belowEditor";
export type PiPendingDetails = Record<string, unknown>;

export interface PiPendingFormatInput {
  id: string;
  namespace: string;
  label?: string;
  text: string;
  details?: PiPendingDetails;
  startedAt: number;
}

export type PiPendingFormatter = (item: PiPendingFormatInput) => string;
export type PiPendingShowId = boolean | "auto";

export interface PiPendingStartInput {
  id: string;
  label?: string;
  text: string;
  startedAt?: number;
  details?: PiPendingDetails;
}

export interface PiPendingUpdateInput {
  label?: string;
  text?: string;
  details?: PiPendingDetails;
}

export interface PiPendingOptions {
  namespace: string;
  /** @deprecated pi-pending always renders to the shared "pi-pending" widget. */
  widgetId?: string;
  placement?: PiPendingPlacement;
  format?: PiPendingFormatter;
  showId?: PiPendingShowId;
  minElapsedColumnWidth?: number;
  minIdColumnWidth?: number;
}

export interface PiPendingRegistry {
  attach(ui: ExtensionUIContext): void;
  detach(ui?: ExtensionUIContext): void;
  start(item: PiPendingStartInput): void;
  update(id: string, patch: PiPendingUpdateInput): void;
  finish(id: string): void;
  clear(): void;
  list(): PiPendingFormatInput[];
}

interface InternalPendingItem extends PiPendingFormatInput {
  key: string;
  sequence: number;
  format: PiPendingFormatter;
  showId: PiPendingShowId;
  minElapsedColumnWidth: number;
  minIdColumnWidth: number;
}

interface PiPendingGlobalState {
  ui: ExtensionUIContext | undefined;
  widgetId: string;
  placement: PiPendingPlacement;
  items: Map<string, InternalPendingItem>;
  nextSequence: number;
  widgetInstalled: boolean;
}

const DEFAULT_WIDGET_ID = "pi-pending";
const DEFAULT_MIN_ELAPSED_COLUMN_WIDTH = "4m 16s".length;
const GLOBAL_KEY = Symbol.for("pi-pending.globalState");

function globalState(): PiPendingGlobalState {
  const record = globalThis as typeof globalThis & { [GLOBAL_KEY]?: PiPendingGlobalState };
  if (!record[GLOBAL_KEY]) {
    record[GLOBAL_KEY] = {
      widgetId: DEFAULT_WIDGET_ID,
      placement: "aboveEditor",
      items: new Map(),
      nextSequence: 1,
      ui: undefined,
      widgetInstalled: false,
    };
  }
  return record[GLOBAL_KEY];
}

function namespaceKey(namespace: string, id: string): string {
  return `${namespace}:${id}`;
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function formatElapsedDuration(startedAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatElapsedSeconds(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 1000 ? String(seconds).padStart(3, "0") : String(seconds);
}

function defaultFormat(item: PiPendingFormatInput): string {
  return item.label ? `${item.label}: ${item.text}` : item.text;
}

function shouldShowId(item: InternalPendingItem): boolean {
  return item.showId === true || (item.showId === "auto" && item.label === undefined);
}

function sortedItems(state: PiPendingGlobalState): InternalPendingItem[] {
  return [...state.items.values()].sort((a, b) => a.sequence - b.sequence);
}

function createPendingWidget(state: PiPendingGlobalState, tui: TUI, theme: Theme): Component & { dispose(): void } {
  const interval = setInterval(() => tui.requestRender(), 1000);
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      const rows = sortedItems(state).map((item) => ({
        item,
        body: normalizeVisibleText(item.format(item)),
        elapsed: formatElapsedDuration(item.startedAt),
        id: shouldShowId(item) ? item.id : undefined,
      }));
      const elapsedWidth = rows.reduce(
        (max, row) => Math.max(max, row.item.minElapsedColumnWidth, visibleWidth(row.elapsed)),
        0,
      );
      const idWidth = rows.reduce(
        (max, row) => Math.max(max, row.item.minIdColumnWidth, visibleWidth(row.id ?? "")),
        0,
      );
      return rows.map((row) => {
        const elapsed = padToWidth(row.elapsed, elapsedWidth);
        const prefix = row.id
          ? `${elapsed} ${padToWidth(row.id, idWidth)} `
          : `${elapsed} `;
        const line = padToWidth(truncateToWidth(`${prefix}${row.body}`, width, "..."), width);
        return theme.bg("toolPendingBg", theme.fg("toolTitle", line));
      });
    },
    invalidate() {},
    dispose() {
      clearInterval(interval);
    },
  };
}

function reconcileWidget(state: PiPendingGlobalState): void {
  if (!state.ui) return;
  if (state.items.size === 0) {
    if (state.widgetInstalled) {
      state.ui.setWidget(state.widgetId, undefined);
      state.widgetInstalled = false;
    }
    return;
  }
  if (state.widgetInstalled) return;
  state.ui.setWidget(
    state.widgetId,
    (tui, theme) => createPendingWidget(state, tui, theme),
    { placement: state.placement },
  );
  state.widgetInstalled = true;
}

export function createPiPending(options: PiPendingOptions): PiPendingRegistry {
  const namespace = normalizeVisibleText(options.namespace);
  if (!namespace) throw new Error("pi-pending namespace is required");
  const format = options.format ?? defaultFormat;
  const showId = options.showId ?? true;
  const minElapsedColumnWidth = options.minElapsedColumnWidth ?? DEFAULT_MIN_ELAPSED_COLUMN_WIDTH;
  const minIdColumnWidth = options.minIdColumnWidth ?? 0;
  const state = globalState();
  state.widgetId = DEFAULT_WIDGET_ID;
  state.placement = options.placement ?? state.placement ?? "aboveEditor";

  return {
    attach(ui: ExtensionUIContext): void {
      state.ui = ui;
      reconcileWidget(state);
    },
    detach(ui?: ExtensionUIContext): void {
      if (ui && state.ui !== ui) return;
      if (state.ui && state.widgetInstalled) state.ui.setWidget(state.widgetId, undefined);
      state.ui = undefined;
      state.widgetInstalled = false;
    },
    start(item: PiPendingStartInput): void {
      const id = normalizeVisibleText(item.id);
      if (!id) throw new Error("pi-pending item id is required");
      const key = namespaceKey(namespace, id);
      const existing = state.items.get(key);
      state.items.set(key, {
        key,
        id,
        namespace,
        text: item.text,
        startedAt: item.startedAt ?? existing?.startedAt ?? Date.now(),
        sequence: existing?.sequence ?? state.nextSequence++,
        format,
        showId,
        minElapsedColumnWidth,
        minIdColumnWidth,
        ...(item.label !== undefined ? { label: item.label } : {}),
        ...(item.details !== undefined ? { details: item.details } : {}),
      });
      reconcileWidget(state);
    },
    update(id: string, patch: PiPendingUpdateInput): void {
      const key = namespaceKey(namespace, id);
      const item = state.items.get(key);
      if (!item) return;
      state.items.set(key, {
        ...item,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.details !== undefined ? { details: patch.details } : {}),
      });
      reconcileWidget(state);
    },
    finish(id: string): void {
      state.items.delete(namespaceKey(namespace, id));
      reconcileWidget(state);
    },
    clear(): void {
      for (const key of [...state.items.keys()]) {
        if (key.startsWith(`${namespace}:`)) state.items.delete(key);
      }
      reconcileWidget(state);
    },
    list(): PiPendingFormatInput[] {
      return sortedItems(state)
        .filter((item) => item.namespace === namespace)
        .map(({ id, label, text, details, startedAt }) => ({
          id,
          text,
          startedAt,
          ...(label !== undefined ? { label } : {}),
          ...(details !== undefined ? { details } : {}),
          namespace,
        }));
    },
  };
}
