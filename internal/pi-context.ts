// Local replacement for the "pi-context" npm dependency.
//
// Why this file exists: pi-background-bash's package.json pinned
// "pi-context": "github:sshkeda/pi-context#v0.1.6". As of this fork, the
// upstream GitHub repository sshkeda/pi-context no longer resolves (git
// ls-remote and the GitHub API both return "Repository not found", and the
// exact pinned commit is unreachable via codeload tarball too), so the
// dependency cannot be fetched by any protocol, git or https. There is a
// same-named package on the public npm registry, but it belongs to a
// different, unrelated author/project ("Agentic Context Management for Pi"
// by ttttmr) and must not be substituted in; doing so would be a
// dependency-confusion risk, not a fix.
//
// This module reimplements only the three exports background-bash.ts
// actually consumes: piContext, truncateContextText, formatTruncationNotice.
// The XML-ish wrapper format (piContext) is not a guess: the same author
// (sshkeda) already duplicated the identical attribute-escaping wrapper
// logic in two sibling packages in this dependency graph, bin/pbb.js
// (this repo) and pi-lane's bin/pil.js, both with matching attr()/
// escapeBody()/context() helpers. This file follows that established
// pattern. The truncation behavior (line/byte tail-capping, and the
// "Showing lines X-Y of Z." notice text) is derived from the exact
// call sites in extensions/background-bash.ts and the behavioral
// assertions in test/background-bash.test.mjs.

export interface PiContextInput {
	source: string;
	kind: string;
	id?: string;
	attrs?: Record<string, unknown>;
	body: string;
}

function escapeAttr(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\r/g, "&#13;")
		.replace(/\n/g, "&#10;");
}

export function piContext(input: PiContextInput): string {
	const merged: Record<string, unknown> = {
		source: input.source,
		kind: input.kind,
		...(input.id !== undefined ? { id: input.id } : {}),
		...(input.attrs ?? {}),
	};
	const renderedAttrs = Object.entries(merged)
		.filter(([, value]) => value !== undefined && value !== null && value !== false)
		.map(([key, value]) => `${key}="${escapeAttr(value)}"`)
		.join(" ");
	return `<pi_context ${renderedAttrs}>\n${input.body}\n</pi_context>`;
}

export type TruncationMode = "tail";

export interface TruncationInfo {
	truncated: boolean;
	totalLines: number;
	keptStartLine: number;
	keptEndLine: number;
	totalBytes: number;
	keptBytes: number;
}

export interface TruncateContextTextOptions {
	mode?: TruncationMode;
	maxLines?: number;
	maxBytes?: number;
	appendNotice?: boolean;
}

export interface TruncateContextTextResult {
	content: string;
	truncation?: TruncationInfo;
}

export function truncateContextText(text: string, options: TruncateContextTextOptions = {}): TruncateContextTextResult {
	const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;
	const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
	const totalBytes = Buffer.byteLength(text, "utf8");
	const lines = text.split("\n");
	const totalLines = lines.length;

	let keptStartIndex = 0;
	if (totalLines > maxLines) keptStartIndex = totalLines - maxLines;

	let segment = lines.slice(keptStartIndex);
	let kept = segment.join("\n");

	if (Buffer.byteLength(kept, "utf8") > maxBytes) {
		while (segment.length > 1 && Buffer.byteLength(segment.join("\n"), "utf8") > maxBytes) {
			segment = segment.slice(1);
			keptStartIndex += 1;
		}
		kept = segment.join("\n");
		if (Buffer.byteLength(kept, "utf8") > maxBytes) {
			// A single remaining line is still over the byte cap; hard-cut its tail.
			const buf = Buffer.from(kept, "utf8");
			kept = buf.subarray(buf.length - maxBytes).toString("utf8");
		}
	}

	const truncated = kept !== text;
	if (!truncated) {
		return {
			content: text,
			truncation: { truncated: false, totalLines, keptStartLine: 1, keptEndLine: totalLines, totalBytes, keptBytes: totalBytes },
		};
	}

	const truncation: TruncationInfo = {
		truncated: true,
		totalLines,
		keptStartLine: keptStartIndex + 1,
		keptEndLine: totalLines,
		totalBytes,
		keptBytes: Buffer.byteLength(kept, "utf8"),
	};

	const content = options.appendNotice ? `${kept}\n\n${formatTruncationNotice(truncation, options.mode ?? "tail")}` : kept;
	return { content, truncation };
}

export function formatTruncationNotice(truncation: TruncationInfo, _mode: TruncationMode = "tail"): string {
	return `Showing lines ${truncation.keptStartLine}-${truncation.keptEndLine} of ${truncation.totalLines}.`;
}
