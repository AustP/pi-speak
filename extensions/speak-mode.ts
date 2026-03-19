import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DAEMON_FILENAME = "qwen3_tts_daemon.py";
const DAEMON_READY_TIMEOUT_MS = 180000;
const STATUS_KEY = "speak-mode";
const MAX_SPOKEN_TEXT_LENGTH = 260;
const STILL_WORKING_INTERVAL_MS = 17000;
const EXTENSION_DIR = __dirname;
const PROJECT_ROOT = path.resolve(EXTENSION_DIR, "..");
const PYTHON_EXECUTABLE = path.join(PROJECT_ROOT, ".venv/bin/python");
const LISTENER_PACKAGE_PATH = path.join(PROJECT_ROOT, "listener");
const TTS_CONTROL_SOCKET_PATH = path.join(os.tmpdir(), "pi-tts-control.sock");
const GLIMPSE_MODULE_PATH = "/Users/aust/src/glimpse/src/glimpse.mjs";
const FULL_OUTPUT_TRIGGER_PATTERN = /\bfull output\b/i;
const WINSTON_TRIGGER_PATTERN = /\bwinston\b/i;

type UIContext = {
	ui: {
		setStatus: (key: string, value: string | undefined) => void;
		notify: (message: string, level?: "info" | "success" | "warning" | "error") => void;
	};
};

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let daemon: ChildProcessWithoutNullStreams | null = null;
	let listener: ChildProcessWithoutNullStreams | null = null;
	let ttsControlServer: net.Server | null = null;
	let daemonReady = false;
	let startupPromise: Promise<void> | null = null;
	let listenerStartupPromise: Promise<void> | null = null;
	let pendingPayloads: string[] = [];
	let lastAssistantOutput = "";
	let acknowledgedUserMessageInTurn = false;
	let stillWorkingInterval: NodeJS.Timeout | null = null;

	const setStatus = (ctx: UIContext, state: "off" | "loading" | "on") => {
		ctx.ui.setStatus(STATUS_KEY, state === "loading" ? "🔊 Speak: Loading" : state === "on" ? "🔊 Speak: ON" : "🔇 Speak: OFF");
	};

	const normalize = (text: string): string => {
		const singleLine = text.replace(/\s+/g, " ").trim();
		const withoutEmoji = singleLine.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s+/g, " ").trim();
		if (!withoutEmoji) return "";
		if (withoutEmoji.length <= MAX_SPOKEN_TEXT_LENGTH) return withoutEmoji;
		return `${withoutEmoji.slice(0, MAX_SPOKEN_TEXT_LENGTH - 1)}…`;
	};

	const notifyStderrErrorsOnly = (ctx: UIContext, prefix: string, chunk: string) => {
		const output = normalize(chunk);
		if (!output) return;
		if (!/\b(error|exception|fatal|panic|traceback|failed?)\b/i.test(output)) return;
		ctx.ui.notify(`${prefix}: ${output}`, "error");
	};

	const showFullOutputInGlimpse = (text: string, ctx: UIContext) => {
		const script = `
import { prompt } from ${JSON.stringify(GLIMPSE_MODULE_PATH)};

let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
	text += chunk;
}

const escapeHtml = (value) => value
	.replace(/&/g, "&amp;")
	.replace(/</g, "&lt;")
	.replace(/>/g, "&gt;")
	.replace(/\"/g, "&quot;")
	.replace(/'/g, "&#39;");

const escaped = escapeHtml(text);
const html = \`<body style="margin:0;background:#111;color:#e5e7eb;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
	<div style="padding:14px 16px;border-bottom:1px solid #2f2f2f;font-family:system-ui, -apple-system, sans-serif;font-size:13px;color:#a3a3a3;">Last full assistant output</div>
	<pre style="margin:0;padding:16px;white-space:pre-wrap;word-break:break-word;line-height:1.45;font-size:13px;">\${escaped}</pre>
</body>\`;

await prompt(html, { width: 980, height: 720, title: "Full Output" });
`;

		const child = spawn("node", ["--input-type=module", "-e", script], {
			cwd: PROJECT_ROOT,
			stdio: ["pipe", "ignore", "ignore"],
			detached: true,
		});
		child.stdin.write(text);
		child.stdin.end();
		child.unref();
		ctx.ui.notify("Opened full output in Glimpse.", "info");
	};

	const enqueuePayload = (payload: { type: "speak" | "summarize_speak"; text: string }) => {
		if (!enabled) return;
		const serialized = JSON.stringify(payload);
		if (!daemon || !daemonReady) {
			pendingPayloads.push(serialized);
			return;
		}
		daemon.stdin.write(`${serialized}\n`);
	};

	const enqueueSpeech = (text: string) => {
		const line = normalize(text);
		if (!line) return;
		enqueuePayload({ type: "speak", text: line });
	};

	const enqueueSummarizedSpeech = (text: string) => {
		const cleaned = text.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s+/g, " ").trim();
		if (!cleaned) return;
		enqueuePayload({ type: "summarize_speak", text: cleaned });
	};

	const flushPending = () => {
		if (!daemon || !daemonReady) return;
		for (const payload of pendingPayloads) daemon.stdin.write(`${payload}\n`);
		pendingPayloads = [];
	};

	const stopStillWorkingAnnouncements = () => {
		if (!stillWorkingInterval) return;
		clearInterval(stillWorkingInterval);
		stillWorkingInterval = null;
	};

	const startStillWorkingAnnouncements = () => {
		if (!enabled || stillWorkingInterval) return;
		stillWorkingInterval = setInterval(() => {
			if (!enabled) return stopStillWorkingAnnouncements();
			enqueueSpeech("Still working...");
		}, STILL_WORKING_INTERVAL_MS);
	};

	const interruptPlayback = () => {
		pendingPayloads = [];
		if (!daemon || !daemonReady) return;
		try {
			daemon.stdin.write(`${JSON.stringify({ type: "interrupt" })}\n`);
		} catch {}
	};

	const cleanupTtsControlSocket = () => {
		if (!fs.existsSync(TTS_CONTROL_SOCKET_PATH)) return;
		try {
			fs.unlinkSync(TTS_CONTROL_SOCKET_PATH);
		} catch {}
	};

	const startTtsControlServer = (ctx: UIContext) => {
		if (ttsControlServer) return;
		cleanupTtsControlSocket();
		const server = net.createServer((socket) => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline === -1) break;
					const line = buffer.slice(0, newline).trim().toLowerCase();
					buffer = buffer.slice(newline + 1);
					if (line === "interrupt") interruptPlayback();
				}
			});
		});

		server.on("error", (error: NodeJS.ErrnoException) => {
			if (ttsControlServer === server) ttsControlServer = null;
			cleanupTtsControlSocket();
			ctx.ui.notify(`TTS control socket error (${TTS_CONTROL_SOCKET_PATH}): ${error.message}`, "error");
		});

		server.listen(TTS_CONTROL_SOCKET_PATH, () => {
			ttsControlServer = server;
		});
	};

	const stopTtsControlServer = () => {
		if (ttsControlServer) {
			ttsControlServer.close();
			ttsControlServer = null;
		}
		cleanupTtsControlSocket();
	};

	const stopDaemon = (ctx: UIContext | null) => {
		stopStillWorkingAnnouncements();
		daemonReady = false;
		startupPromise = null;
		pendingPayloads = [];
		if (!daemon) return;
		try {
			daemon.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
			daemon.stdin.end();
		} catch {}
		daemon.kill("SIGTERM");
		daemon = null;
		ctx?.ui.notify("Speak mode model unloaded.", "info");
	};

	const startListener = async (ctx: UIContext) => {
		if (listener) return;
		if (listenerStartupPromise) return listenerStartupPromise;
		if (!fs.existsSync(LISTENER_PACKAGE_PATH)) throw new Error(`Missing listener package at ${LISTENER_PACKAGE_PATH}.`);

		listenerStartupPromise = new Promise<void>((resolve, reject) => {
			const child = spawn("swift", ["run", "--package-path", LISTENER_PACKAGE_PATH], { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
			listener = child;
			let settled = false;
			const settleSuccess = () => {
				if (settled) return;
				settled = true;
				listenerStartupPromise = null;
				resolve();
			};
			const settleError = (error: Error) => {
				if (settled) return;
				settled = true;
				listenerStartupPromise = null;
				reject(error);
			};

			const startupTimer = setTimeout(settleSuccess, 1500);
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => notifyStderrErrorsOnly(ctx, "Listener", chunk));
			child.on("exit", (code, signal) => {
				clearTimeout(startupTimer);
				listener = null;
				if (!settled) return settleError(new Error(`Listener stopped during startup (${code ?? signal ?? "unknown"}).`));
				if (enabled) ctx.ui.notify(`Listener stopped (${code ?? signal ?? "unknown"}).`, "error");
			});
			child.on("error", (error) => {
				clearTimeout(startupTimer);
				listener = null;
				if (!settled) return settleError(error);
				ctx.ui.notify(`Listener error: ${error.message}`, "error");
			});
		});

		return listenerStartupPromise;
	};

	const stopListener = (ctx: UIContext | null) => {
		listenerStartupPromise = null;
		if (!listener) return;
		listener.kill("SIGTERM");
		listener = null;
		ctx?.ui.notify("Listener stopped.", "info");
	};

	const startDaemon = async (ctx: UIContext) => {
		if (daemon && daemonReady) return;
		if (startupPromise) return startupPromise;

		startupPromise = new Promise<void>((resolve, reject) => {
			const daemonScript = path.join(EXTENSION_DIR, DAEMON_FILENAME);
			let startupStderr = "";
			if (!fs.existsSync(PYTHON_EXECUTABLE)) return reject(new Error(`Missing virtualenv python at ${PYTHON_EXECUTABLE}. Run ./setup_venv.sh first.`));

			const child = spawn(PYTHON_EXECUTABLE, [daemonScript], { cwd: PROJECT_ROOT, stdio: ["pipe", "pipe", "pipe"] });
			daemon = child;

			const timeout = setTimeout(() => {
				startupPromise = null;
				daemonReady = false;
				child.kill("SIGTERM");
				const err = normalize(startupStderr);
				reject(new Error(err ? `Timed out waiting for TTS+summarizer models to load: ${err}` : "Timed out waiting for TTS+summarizer models to load."));
			}, DAEMON_READY_TIMEOUT_MS);

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (!daemonReady && chunk.includes("READY")) {
					clearTimeout(timeout);
					daemonReady = true;
					startupPromise = null;
					flushPending();
					resolve();
				}
			});

			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				if (!daemonReady) {
					startupStderr += chunk;
					return;
				}
				notifyStderrErrorsOnly(ctx, "Speak daemon", chunk);
			});

			child.on("exit", (code, signal) => {
				clearTimeout(timeout);
				if (!daemonReady) {
					const err = normalize(startupStderr);
					reject(new Error(err ? `TTS daemon exited before ready (${code ?? signal ?? "unknown"}): ${err}` : `TTS daemon exited before ready (${code ?? signal ?? "unknown"}).`));
				}
				daemonReady = false;
				startupPromise = null;
				daemon = null;
			});

			child.on("error", (error) => {
				clearTimeout(timeout);
				daemonReady = false;
				startupPromise = null;
				daemon = null;
				reject(error);
			});
		});

		return startupPromise;
	};

	const spokenPath = (value: string): string => value.replace(/^\.?\//, "").replace(/[\\/]+/g, " slash ").replace(/\./g, " dot ").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

	const spokenFriendlyText = (text: string): string => {
		const withoutLinks = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
		const withoutHeadingHashes = withoutLinks.replace(/^\s{0,3}#{1,6}\s+/gm, "");
		const withoutMarkdown = withoutHeadingHashes.replace(/\*\*(.*?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
		const pathFriendly = withoutMarkdown.replace(/(^|\s)([.~]?[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+)(?=\s|$)/g, (_m, prefix, pathValue) => {
			if (typeof pathValue !== "string" || !pathValue.includes("/")) return `${prefix}${pathValue}`;
			return `${prefix}${spokenPath(pathValue)}`;
		});
		return pathFriendly
			.replace(/\bstderr\b/gi, "STD err")
			.replace(/\bstdout\b/gi, "STD out")
			.replace(/\bstdin\b/gi, "STD in")
			.replace(/\bwinston\b/gi, "He Who Must Not Be Named")
			.split(/\r?\n/)
			.map((line) => line.replace(/[ \t]+/g, " ").trim())
			.join("\n")
			.trim();
	};

	const rawMessageTextSegments = (message: any): string[] => {
		if (!message || message.role !== "assistant") return [];
		const content = Array.isArray(message.content) ? message.content : [];
		const segments: string[] = [];
		for (const item of content) {
			if (item?.type !== "text" || typeof item.text !== "string") continue;
			const raw = item.text.trim();
			if (raw) segments.push(raw);
		}
		return segments;
	};

	const messageTextSegments = (message: any): string[] => {
		const segments = rawMessageTextSegments(message);
		return segments.map((segment) => spokenFriendlyText(segment)).filter((segment) => segment.length > 0);
	};

	const latestAssistantOutputFromSession = (ctx: any): string => {
		const entries = ctx?.sessionManager?.getEntries?.();
		if (!Array.isArray(entries)) return "";

		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (!entry || entry.type !== "message") continue;
			const message = entry.message;
			if (!message || message.role !== "assistant") continue;
			const rawSegments = rawMessageTextSegments(message);
			if (rawSegments.length === 0) continue;
			return rawSegments.join("\n\n");
		}

		return "";
	};

	pi.on("session_start", async (_event, ctx) => {
		lastAssistantOutput = latestAssistantOutputFromSession(ctx as any);
		acknowledgedUserMessageInTurn = false;
		stopStillWorkingAnnouncements();
		startTtsControlServer(ctx as UIContext);
		setStatus(ctx as UIContext, "off");
	});

	pi.registerCommand("speak", {
		description: "Toggle spoken final assistant responses",
		handler: async (_args, ctx) => {
			const typedCtx = ctx as UIContext;
			enabled = !enabled;
			if (enabled) {
				setStatus(typedCtx, "loading");
				typedCtx.ui.notify("Speak mode enabled. Loading TTS and summarizer models, then starting listener...", "info");
				try {
					await startDaemon(typedCtx);
					await startListener(typedCtx);
					setStatus(typedCtx, "on");
					typedCtx.ui.notify("Speak mode enabled.", "success");
				} catch (error: any) {
					enabled = false;
					stopListener(typedCtx);
					stopDaemon(typedCtx);
					setStatus(typedCtx, "off");
					typedCtx.ui.notify(`Failed to enable speak mode: ${error?.message ?? String(error)}`, "error");
				}
				return;
			}
			stopListener(typedCtx);
			stopDaemon(typedCtx);
			setStatus(typedCtx, "off");
			typedCtx.ui.notify("Speak mode disabled.", "info");
		},
	});

	pi.on("turn_start", async () => {
		acknowledgedUserMessageInTurn = false;
	});

	pi.on("input", async (event, ctx) => {
		if (!enabled) return { action: "continue" };
		const text = event.text ?? "";
		if (!FULL_OUTPUT_TRIGGER_PATTERN.test(text) || !WINSTON_TRIGGER_PATTERN.test(text)) return { action: "continue" };
		const typedCtx = ctx as UIContext;
		if (!lastAssistantOutput) {
			lastAssistantOutput = latestAssistantOutputFromSession(ctx as any);
		}
		if (!lastAssistantOutput) {
			typedCtx.ui.notify("No previous assistant output is available yet.", "warning");
			return { action: "handled" };
		}
		try {
			showFullOutputInGlimpse(lastAssistantOutput, typedCtx);
		} catch (error: any) {
			typedCtx.ui.notify(`Failed to open Glimpse window: ${error?.message ?? String(error)}`, "error");
		}
		return { action: "handled" };
	});

	pi.on("message_start", async (event) => {
		const message = (event as any).message;
		if (!message) return;
		if (message.role !== "user") return;
		if (!enabled) return;
		interruptPlayback();
		if (!acknowledgedUserMessageInTurn) {
			enqueueSpeech("Message received. Working...");
			acknowledgedUserMessageInTurn = true;
		}
		startStillWorkingAnnouncements();
	});

	pi.on("message_end", async (event) => {
		const message = (event as any).message;
		if (!message || message.role !== "assistant") return;

		const rawSegments = rawMessageTextSegments(message);
		if (rawSegments.length > 0) {
			lastAssistantOutput = rawSegments.join("\n\n");
		}

		if (!enabled) return;
		const segments = messageTextSegments(message);
		if (segments.length === 0) return;
		enqueueSummarizedSpeech(segments.join("\n\n"));
	});

	pi.on("turn_end", async (event) => {
		if (!enabled) return;
		const turnEvent = event as any;
		const message = turnEvent?.message;
		const toolResults = Array.isArray(turnEvent?.toolResults) ? turnEvent.toolResults : [];
		if (!message || message.role !== "assistant") return;
		if (toolResults.length > 0) return;
		stopStillWorkingAnnouncements();
	});

	pi.on("session_shutdown", async () => {
		enabled = false;
		lastAssistantOutput = "";
		acknowledgedUserMessageInTurn = false;
		stopTtsControlServer();
		stopListener(null);
		stopDaemon(null);
	});
}
