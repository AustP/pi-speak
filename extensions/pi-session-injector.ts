import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SOCKET_PATH = path.join(os.tmpdir(), "pi-session-inject.sock");

type UIContext = {
  ui: {
    notify: (message: string, level?: "info" | "success" | "warning" | "error") => void;
  };
};

export default function (pi: ExtensionAPI) {
  let server: net.Server | undefined;
  let isAgentBusy = false;

  const cleanupSocket = () => {
    if (fs.existsSync(SOCKET_PATH)) {
      try {
        fs.unlinkSync(SOCKET_PATH);
      } catch {
        // ignore
      }
    }
  };

  const injectText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    try {
      if (isAgentBusy) {
        pi.sendUserMessage(trimmed, { deliverAs: "followUp" });
      } else {
        pi.sendUserMessage(trimmed);
      }
    } catch {
      // ignore injection failures here; sender gets no response contract
    }
  };

  const startServer = (ctx: UIContext) => {
    if (server) return;

    cleanupSocket();

    const nextServer = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";

      socket.on("data", (chunk: string) => {
        buffer += chunk;

        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;

          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);

          if (!line) continue;
          injectText(line);
        }
      });
    });

    nextServer.on("error", (error: NodeJS.ErrnoException) => {
      if (server === nextServer) {
        server = undefined;
      }
      cleanupSocket();
      ctx.ui.notify(`PI inject socket error (${SOCKET_PATH}): ${error.message}`, "error");
    });

    nextServer.listen(SOCKET_PATH, () => {
      server = nextServer;
      ctx.ui.notify(`PI inject socket ready: ${SOCKET_PATH}`, "info");
    });
  };

  const stopServer = () => {
    if (server) {
      server.close();
      server = undefined;
    }
    cleanupSocket();
  };

  pi.on("session_start", async (_event, ctx) => {
    startServer(ctx as UIContext);
  });

  pi.on("agent_start", async () => {
    isAgentBusy = true;
  });

  pi.on("agent_end", async () => {
    isAgentBusy = false;
  });

  pi.on("session_shutdown", async () => {
    stopServer();
  });

  pi.registerCommand("inject-status", {
    description: "Show socket path for external message injection",
    handler: async (_args, ctx) => {
      const running = fs.existsSync(SOCKET_PATH);
      ctx.ui.notify(
        running
          ? `Injection socket active: ${SOCKET_PATH}`
          : `Injection socket inactive: ${SOCKET_PATH}`,
        running ? "info" : "warning"
      );
    },
  });
}
