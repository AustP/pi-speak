import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DAEMON_FILENAME = "qwen3_tts_daemon.py";
const DAEMON_READY_TIMEOUT_MS = 120000;
const STATUS_KEY = "speak-mode";
const MAX_SPOKEN_TEXT_LENGTH = 260;
const STILL_WORKING_INTERVAL_MS = 7000;
const EXTENSION_DIR = __dirname;
const PROJECT_ROOT = path.resolve(EXTENSION_DIR, "..");
const PYTHON_EXECUTABLE = path.join(PROJECT_ROOT, ".venv/bin/python");
const LISTENER_PACKAGE_PATH = path.join(PROJECT_ROOT, "listener");
const TTS_CONTROL_SOCKET_PATH = path.join(os.tmpdir(), "pi-tts-control.sock");

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
	let pendingSpeech: string[] = [];
	let streamingTextBuffer = "";
	let sawStreamingTextDelta = false;
	let acknowledgedUserMessageInTurn = false;
	let stillWorkingInterval: NodeJS.Timeout | null = null;

	const setStatus = (ctx: UIContext, state: "off" | "loading" | "on") => {
		if (state === "loading") {
			ctx.ui.setStatus(STATUS_KEY, "🔊 Speak: Loading");
			return;
		}
		if (state === "on") {
			ctx.ui.setStatus(STATUS_KEY, "🔊 Speak: ON");
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "🔇 Speak: OFF");
	};

	const normalize = (text: string): string => {
		const singleLine = text.replace(/\s+/g, " ").trim();
		const withoutEmoji = singleLine.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s+/g, " ").trim();
		if (!withoutEmoji) return "";
		if (withoutEmoji.length <= MAX_SPOKEN_TEXT_LENGTH) return withoutEmoji;
		return `${withoutEmoji.slice(0, MAX_SPOKEN_TEXT_LENGTH - 1)}…`;
	};

	const errorLikePattern = /\b(error|exception|fatal|panic|traceback|failed?)\b/i;

	const notifyStderrErrorsOnly = (ctx: UIContext, prefix: string, chunk: string) => {
		const output = normalize(chunk);
		if (!output) return;
		if (!errorLikePattern.test(output)) return;
		ctx.ui.notify(`${prefix}: ${output}`, "error");
	};

	const enqueueSpeech = (text: string) => {
		if (!enabled) return;
		const line = normalize(text);
		if (!line) return;

		if (!daemon || !daemonReady) {
			pendingSpeech.push(line);
			return;
		}

		daemon.stdin.write(`${JSON.stringify({ type: "speak", text: line })}\n`);
	};

	const flushPending = () => {
		if (!daemon || !daemonReady) return;
		for (const text of pendingSpeech) {
			daemon.stdin.write(`${JSON.stringify({ type: "speak", text })}\n`);
		}
		pendingSpeech = [];
	};

	const stopStillWorkingAnnouncements = () => {
		if (!stillWorkingInterval) return;
		clearInterval(stillWorkingInterval);
		stillWorkingInterval = null;
	};

	const startStillWorkingAnnouncements = () => {
		if (!enabled) return;
		if (stillWorkingInterval) return;
		stillWorkingInterval = setInterval(() => {
			if (!enabled) {
				stopStillWorkingAnnouncements();
				return;
			}
			enqueueSpeech("Still working...");
		}, STILL_WORKING_INTERVAL_MS);
	};

	const interruptPlayback = () => {
		pendingSpeech = [];
		if (!daemon || !daemonReady) return;
		try {
			daemon.stdin.write(`${JSON.stringify({ type: "interrupt" })}\n`);
		} catch {
			// Ignore interruption stream errors.
		}
	};

	const cleanupTtsControlSocket = () => {
		if (!fs.existsSync(TTS_CONTROL_SOCKET_PATH)) return;
		try {
			fs.unlinkSync(TTS_CONTROL_SOCKET_PATH);
		} catch {
			// Ignore cleanup errors.
		}
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
			if (ttsControlServer === server) {
				ttsControlServer = null;
			}
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
		pendingSpeech = [];

		if (!daemon) return;

		try {
			daemon.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
			daemon.stdin.end();
		} catch {
			// Ignore shutdown stream errors.
		}

		daemon.kill("SIGTERM");
		daemon = null;
		ctx?.ui.notify("Speak mode model unloaded.", "info");
	};

	const startListener = async (ctx: UIContext) => {
		if (listener) return;
		if (listenerStartupPromise) return listenerStartupPromise;
		if (!fs.existsSync(LISTENER_PACKAGE_PATH)) {
			throw new Error(`Missing listener package at ${LISTENER_PACKAGE_PATH}.`);
		}

		listenerStartupPromise = new Promise<void>((resolve, reject) => {
			const child = spawn("swift", ["run", "--package-path", LISTENER_PACKAGE_PATH], {
				cwd: PROJECT_ROOT,
				stdio: ["ignore", "pipe", "pipe"],
			});
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

			const startupTimer = setTimeout(() => {
				settleSuccess();
			}, 1500);

			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				notifyStderrErrorsOnly(ctx, "Listener", chunk);
			});

			child.on("exit", (code, signal) => {
				clearTimeout(startupTimer);
				listener = null;
				if (!settled) {
					settleError(new Error(`Listener stopped during startup (${code ?? signal ?? "unknown"}).`));
					return;
				}
				if (!enabled) return;
				ctx.ui.notify(`Listener stopped (${code ?? signal ?? "unknown"}).`, "error");
			});

			child.on("error", (error) => {
				clearTimeout(startupTimer);
				listener = null;
				if (!settled) {
					settleError(error);
					return;
				}
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

			if (!fs.existsSync(PYTHON_EXECUTABLE)) {
				startupPromise = null;
				reject(new Error(`Missing virtualenv python at ${PYTHON_EXECUTABLE}. Run ./setup_venv.sh first.`));
				return;
			}

			const child = spawn(PYTHON_EXECUTABLE, [daemonScript], {
				cwd: PROJECT_ROOT,
				stdio: ["pipe", "pipe", "pipe"],
			});
			daemon = child;

			const timeout = setTimeout(() => {
				startupPromise = null;
				daemonReady = false;
				child.kill("SIGTERM");
				const err = normalize(startupStderr);
				reject(new Error(err ? `Timed out waiting for TTS model to load: ${err}` : "Timed out waiting for TTS model to load."));
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

	const spokenPath = (value: string): string => {
		return value
			.replace(/^\.?\//, "")
			.replace(/[\\/]+/g, " slash ")
			.replace(/\./g, " dot ")
			.replace(/[-_]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	};

	const spokenFriendlyText = (text: string): string => {
		const withoutLinks = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
		const withoutHeadingHashes = withoutLinks.replace(/^\s{0,3}#{1,6}\s+/gm, "");
		const withoutMarkdown = withoutHeadingHashes.replace(/\*\*(.*?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
		const pathFriendly = withoutMarkdown.replace(/(^|\s)([.~]?[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+)(?=\s|$)/g, (_match, prefix, pathValue) => {
			if (typeof pathValue !== "string" || !pathValue.includes("/")) return `${prefix}${pathValue}`;
			return `${prefix}${spokenPath(pathValue)}`;
		});
		const streamTermsFriendly = pathFriendly
			.replace(/\bstderr\b/gi, "STD err")
			.replace(/\bstdout\b/gi, "STD out")
			.replace(/\bstdin\b/gi, "STD in");
		const slashFriendly = streamTermsFriendly.replace(/\//g, " slash ");
		const decimalFriendly = slashFriendly.replace(/\b\d+(?:\.\d+)+\b/g, (match) => match.replace(/\./g, " point "));

		return decimalFriendly
			.split(/\r?\n/)
			.map((line) => line.replace(/[ \t]+/g, " ").trim())
			.join("\n")
			.trim();
	};

	const messageTextSegments = (message: any): string[] => {
		if (!message || message.role !== "assistant") return [];
		const content = Array.isArray(message.content) ? message.content : [];
		const segments: string[] = [];

		for (const item of content) {
			if (item?.type === "text" && typeof item.text === "string") {
				const text = spokenFriendlyText(item.text);
				if (text) segments.push(text);
			}
		}

		return segments;
	};

	const allSpokenChunks = (text: string): string[] => {
		const DOT_PLACEHOLDER = "∯";
		const abbreviations = [
			"e.g.",
			"i.e.",
			"etc.",
			"vs.",
			"mr.",
			"mrs.",
			"ms.",
			"dr.",
			"prof.",
			"sr.",
			"jr.",
			"u.s.",
			"u.k.",
		];

		const splitLineIntoSentences = (line: string): string[] => {
			let normalizedLine = line.replace(/\s+/g, " ").trim();
			if (!normalizedLine) return [];
			normalizedLine = normalizedLine.replace(/^\-\s*/, "");

			const escaped = abbreviations.reduce((acc, abbreviation) => {
				const escapedAbbreviation = abbreviation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const pattern = new RegExp(`\\b${escapedAbbreviation}`, "gi");
				return acc.replace(pattern, (match) => match.replace(/\./g, DOT_PLACEHOLDER));
			}, normalizedLine);

			const sentences = escaped
				.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)
				?.map((part) => part.replace(new RegExp(DOT_PLACEHOLDER, "g"), ".").trim())
				.filter((part) => part.length > 0);

			return sentences && sentences.length > 0 ? sentences : [normalizedLine];
		};

		return text
			.split(/\r?\n/)
			.flatMap((line) => splitLineIntoSentences(line))
			.map((chunk) => chunk.trim())
			.filter((chunk) => chunk.length > 0);
	};

	const extractCompleteSentences = (text: string): { complete: string[]; remainder: string } => {
		const DOT_PLACEHOLDER = "∯";
		const PATH_DOT_PLACEHOLDER = "∷";
		const abbreviations = ["e.g.", "i.e.", "etc.", "vs.", "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "u.s.", "u.k."];

		const abbreviationsEscaped = abbreviations.reduce((acc, abbreviation) => {
			const escapedAbbreviation = abbreviation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(`\\b${escapedAbbreviation}`, "gi");
			return acc.replace(pattern, (match) => match.replace(/\./g, DOT_PLACEHOLDER));
		}, text);

		const pathsEscaped = abbreviationsEscaped.replace(/(^|\s)([.~]?[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+)(?=\s|$)/g, (match, prefix, pathValue) => {
			if (typeof pathValue !== "string") return match;
			return `${prefix}${pathValue.replace(/\./g, PATH_DOT_PLACEHOLDER)}`;
		});

		const restorePlaceholders = (value: string) => value
			.replace(new RegExp(DOT_PLACEHOLDER, "g"), ".")
			.replace(new RegExp(PATH_DOT_PLACEHOLDER, "g"), ".");

		const sentencePattern = /[^.!?]+[.!?]+(?:["')\]]+)?/g;
		const complete: string[] = [];
		let lastConsumed = 0;
		let match: RegExpExecArray | null = null;
		while ((match = sentencePattern.exec(pathsEscaped)) !== null) {
			const value = restorePlaceholders(match[0]).trim();
			if (value) complete.push(value);
			lastConsumed = sentencePattern.lastIndex;
		}

		const remainder = restorePlaceholders(pathsEscaped.slice(lastConsumed));
		return { complete, remainder };
	};

	const speakTextSegments = (message: any): boolean => {
		const segments = messageTextSegments(message);
		if (segments.length === 0) return false;
		for (const segment of segments) {
			for (const chunk of allSpokenChunks(segment)) {
				enqueueSpeech(chunk);
			}
		}
		return true;
	};

	const flushStreamingRemainder = () => {
		const cleaned = spokenFriendlyText(streamingTextBuffer);
		streamingTextBuffer = "";
		if (!cleaned) return;
		for (const chunk of allSpokenChunks(cleaned)) {
			enqueueSpeech(chunk);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		streamingTextBuffer = "";
		sawStreamingTextDelta = false;
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
				typedCtx.ui.notify("Speak mode enabled. Loading TTS model and starting listener...", "info");
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
		streamingTextBuffer = "";
		sawStreamingTextDelta = false;
		acknowledgedUserMessageInTurn = false;
		stopStillWorkingAnnouncements();
	});

	pi.on("message_start", async (event) => {
		const message = (event as any).message;
		if (!message) return;

		if (message.role === "user") {
			if (enabled) {
				interruptPlayback();
				if (!acknowledgedUserMessageInTurn) {
					enqueueSpeech("Message received. Working...");
					acknowledgedUserMessageInTurn = true;
				}
				startStillWorkingAnnouncements();
			}
			return;
		}

		if (message.role !== "assistant") return;
		streamingTextBuffer = "";
		sawStreamingTextDelta = false;
	});

	pi.on("message_update", async (event) => {
		if (!enabled) return;
		const assistantMessageEvent = (event as any).assistantMessageEvent;
		if (!assistantMessageEvent || assistantMessageEvent.type !== "text_delta") return;
		if (typeof assistantMessageEvent.delta !== "string" || !assistantMessageEvent.delta) return;

		if (!sawStreamingTextDelta) {
			stopStillWorkingAnnouncements();
		}
		sawStreamingTextDelta = true;
		streamingTextBuffer += assistantMessageEvent.delta;
		const { complete, remainder } = extractCompleteSentences(streamingTextBuffer);
		streamingTextBuffer = remainder;

		for (const sentence of complete) {
			const cleaned = spokenFriendlyText(sentence);
			if (!cleaned) continue;
			for (const chunk of allSpokenChunks(cleaned)) {
				enqueueSpeech(chunk);
			}
		}
	});

	pi.on("message_end", async (event) => {
		if (!enabled) return;
		const message = (event as any).message;
		if (!message || message.role !== "assistant") return;

		stopStillWorkingAnnouncements();
		flushStreamingRemainder();
		if (!sawStreamingTextDelta) {
			speakTextSegments(message);
		}

		streamingTextBuffer = "";
		sawStreamingTextDelta = false;
	});

	pi.on("session_shutdown", async () => {
		enabled = false;
		streamingTextBuffer = "";
		sawStreamingTextDelta = false;
		acknowledgedUserMessageInTurn = false;
		stopTtsControlServer();
		stopListener(null);
		stopDaemon(null);
	});
}
