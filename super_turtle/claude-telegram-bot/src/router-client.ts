/**
 * Router client — connects a worker to the router process.
 *
 * Used by the bot (index.ts) to receive Telegram updates from the router
 * instead of polling Telegram directly.
 */
import { connect, type Socket } from "net";
import type { Update } from "grammy/types";

export interface RouterClientConfig {
  socketPath: string;
  workingDir: string;
  threadId: number | null;
  branch: string | null;
}

type UpdateHandler = (update: Update) => void;
type AssignThreadHandler = (
  threadId: number,
  forumChatId: number | null,
) => void;
type RejectHandler = (reason: string) => void;
type DisconnectHandler = () => void;

const MAX_BUFFER = 1024 * 1024; // 1 MB

export class RouterClient {
  private config: RouterClientConfig;
  private socket: Socket | null = null;
  private buffer = "";
  private connected = false;
  private intentionalClose = false;
  private reconnecting = false;

  private updateHandler: UpdateHandler = () => {};
  private assignThreadHandler: AssignThreadHandler = () => {};
  private rejectHandler: RejectHandler = () => {};
  private disconnectHandler: DisconnectHandler = () => {};

  constructor(config: RouterClientConfig) {
    this.config = config;
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "update" && msg.data) {
        this.updateHandler(msg.data);
      } else if (
        msg.type === "assign_thread" &&
        typeof msg.threadId === "number"
      ) {
        this.assignThreadHandler(msg.threadId, msg.forumChatId ?? null);
      } else if (msg.type === "reject" && typeof msg.reason === "string") {
        this.intentionalClose = true;
        this.rejectHandler(msg.reason);
      }
    } catch {
      // Skip malformed messages
    }
  }

  private sendRegister(): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(
      JSON.stringify({
        type: "register",
        workingDir: this.config.workingDir,
        threadId: this.config.threadId,
        branch: this.config.branch,
        pid: process.pid,
      }) + "\n",
    );
  }

  /** Wire shared data/close handlers onto a socket. */
  private wireSocket(s: Socket): void {
    s.on("data", (data) => {
      this.buffer += data.toString();
      if (this.buffer.length > MAX_BUFFER) {
        console.error(
          `[router-client] Buffer exceeded ${MAX_BUFFER} bytes, destroying connection`,
        );
        this.buffer = "";
        s.destroy();
        return;
      }
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim()) this.handleLine(line);
      }
    });

    s.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      // Only fire disconnect handler for a real connection loss, not for
      // failed reconnection attempts that never reached connected state.
      if (wasConnected) this.disconnectHandler();
      if (!this.intentionalClose && !this.reconnecting) {
        this.reconnectLoop();
      }
    });
  }

  /**
   * Attempt a single connection to the router socket.
   * On success: sends register message and resolves.
   * On failure: rejects (caller retries via connect()).
   */
  private connectToRouter(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const s = connect(this.config.socketPath, () => {
        this.socket = s;
        this.connected = true;
        settled = true;
        this.sendRegister();
        resolve();
      });

      this.wireSocket(s);

      s.on("error", (err) => {
        this.connected = false;
        if (!settled) {
          settled = true;
          // Suppress the close handler's reconnectLoop — the caller handles retries
          this.intentionalClose = true;
          reject(err);
          this.intentionalClose = false;
        }
      });
    });
  }

  private reconnectLoop(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    let delay = 500;
    const attempt = () => {
      if (this.intentionalClose) { this.reconnecting = false; return; }
      console.warn(
        `[router-client] Reconnecting to ${this.config.socketPath} (backoff ${delay}ms)`,
      );
      const s = connect(this.config.socketPath, () => {
        this.socket = s;
        this.connected = true;
        this.reconnecting = false;
        this.buffer = "";
        this.sendRegister();
        console.warn("[router-client] Reconnected successfully");
      });

      this.wireSocket(s);

      s.on("error", () => {
        this.connected = false;
        this.buffer = ""; // Clear stale data from previous connection attempt
        delay = Math.min(delay * 2, 30_000);
        setTimeout(attempt, delay);
      });
    };
    setTimeout(attempt, delay);
  }

  async connect(maxAttempts = 10): Promise<void> {
    let delay = 500;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.connectToRouter();
        return;
      } catch {
        if (i === maxAttempts - 1) {
          throw new Error(
            `Failed to connect to router at ${this.config.socketPath} after ${maxAttempts} attempts`,
          );
        }
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }
  }

  onUpdate(handler: UpdateHandler): void {
    this.updateHandler = handler;
  }

  onAssignThread(handler: AssignThreadHandler): void {
    this.assignThreadHandler = handler;
  }

  onReject(handler: RejectHandler): void {
    this.rejectHandler = handler;
  }

  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandler = handler;
  }

  close(): void {
    this.intentionalClose = true;
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Re-register with a new threadId (after assign_thread) */
  updateRegistration(threadId: number): void {
    this.config.threadId = threadId;
    this.sendRegister();
  }
}
