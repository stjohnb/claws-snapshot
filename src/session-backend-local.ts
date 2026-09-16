import { WebSocket } from "ws";
import {
  createSession,
  createMultiWorktreeSession,
  resumeSession,
  killSession,
  deleteSession,
  getSession,
  listSessions,
  recoverSessions,
  disconnectAllSessions,
  setSessionDescription,
  setSessionAgentStatusForSession,
  resummarizeSession,
  grantSessionCapability,
  sessionGrantDelivery,
  type Session,
} from "./sessions.js";
import { saveSessionUpload, saveSessionUploadStream } from "./session-uploads.js";
import { WsMessageSchema, clampTerminalSize } from "./terminal-protocol.js";
import type { SessionBackend } from "./session-backend.js";

/**
 * `local-tmux` session backend: a thin adapter over `sessions.ts`, which runs
 * each session in a tmux session on the Claws host and bridges it over node-pty.
 */
export const localSessionBackend: SessionBackend = {
  kind: "local-tmux",

  start: () => recoverSessions(),

  shutdown: () => disconnectAllSessions(),

  async create(req) {
    const result = await createSession(req.repo, req.mode, req.capabilities, req.provider, req.model);
    return result.ok ? { ok: true, id: result.session.id } : result;
  },

  async createMulti(req) {
    const result = await createMultiWorktreeSession(req.repos, req.capabilities, req.provider, req.model);
    return result.ok ? { ok: true, id: result.session.id } : result;
  },

  async resume(id) {
    const result = await resumeSession(id);
    return result.ok ? { ok: true, id: result.session.id } : result;
  },

  async end(id) {
    return killSession(id) ? { ok: true } : { ok: false, reason: "not-found" };
  },

  async remove(id) {
    await deleteSession(id);
    return { ok: true };
  },

  async listLive() {
    return listSessions();
  },

  async getLive(id) {
    const s = getSession(id);
    if (!s) return { ok: false, reason: "not-found" };
    return {
      ok: true,
      session: { id: s.id, repo: s.repo, cwd: s.cwd, mode: s.mode, provider: s.provider, model: s.model, alive: s.alive, summary: s.summary, capabilities: s.capabilities },
    };
  },

  async checkAttach(id) {
    return getSession(id) ? { ok: true } : { ok: false, reason: "not-found" };
  },

  attach(id, ws) {
    const session = getSession(id);
    if (!session) {
      ws.close(1008, "Session not found");
      return;
    }
    handleSessionWs(ws, session);
  },

  // The routes check liveness via getLive() before reading the body, so these
  // store straight to the session's upload dir.
  async saveUpload(id, originalName, data) {
    return saveSessionUpload(id, originalName, data);
  },

  async saveUploadStream(id, originalName, source) {
    return saveSessionUploadStream(id, originalName, source);
  },

  setDescription: (id, description) => setSessionDescription(id, description),

  resummarize: (id) => resummarizeSession(id),

  grantCapability: (id, capId) => grantSessionCapability(id, capId),
  grantDelivery: async (id, capId) => sessionGrantDelivery(id, capId),
  setAgentStatus: (id, status) => setSessionAgentStatusForSession(id, status),
};

function handleSessionWs(ws: WebSocket, session: Session): void {
  session.wsConnected = true;
  session.lastActivity = Date.now();

  if (session.scrollback) {
    ws.send(JSON.stringify({ type: "scrollback", data: session.scrollback }));
  }

  if (!session.alive) {
    ws.send(JSON.stringify({ type: "exit", code: session.exitCode }));
  }

  const dataHandler = session.pty.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  const exitHandler = session.pty.onExit(({ exitCode }: { exitCode: number }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
    }
  });

  ws.on("message", (raw: Buffer | string) => {
    session.lastActivity = Date.now();
    try {
      const parseResult = WsMessageSchema.safeParse(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
      if (!parseResult.success) return;
      const msg = parseResult.data;
      if (msg.type === "input" && session.alive) {
        session.pty.write(msg.data);
      } else if (msg.type === "resize") {
        const { cols, rows } = clampTerminalSize(msg.cols, msg.rows);
        session.pty.resize(cols, rows);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    session.wsConnected = false;
    dataHandler.dispose();
    exitHandler.dispose();
  });
}
