import type { Server } from "node:http";

import type { ServerEvent } from "@workhorse/contracts";
import { WebSocketServer, type WebSocket } from "ws";

export type ServerEventListener = (event: ServerEvent) => void;

export class EventBus {
  private readonly clients = new Set<WebSocket>();
  private readonly listeners = new Set<ServerEventListener>();

  public attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (socket: WebSocket) => {
      this.clients.add(socket);

      socket.on("close", () => {
        this.clients.delete(socket);
      });
    });

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws") {
        return;
      }

      wss.handleUpgrade(request, socket, head, (client: WebSocket) => {
        wss.emit("connection", client, request);
      });
    });
  }

  public publish(event: ServerEvent): void {
    const payload = JSON.stringify(event);

    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }

    // In-process listeners run synchronously so the Orchestrator can react
    // (inject system_event messages) before the caller's await resolves.
    // Failures are isolated — a throwing listener must not break the fan-out.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[event-bus] listener threw", error);
      }
    }
  }

  public subscribe(listener: ServerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
