import { createServer, type Server } from "node:http";

import { getRequestListener } from "@hono/node-server";

import { DEFAULT_PORT, DATA_DIR } from "./config.js";
import { createApp } from "./app.js";
import { createFrontendHandler } from "./frontend.js";
import { StateStore } from "./persistence/state-store.js";
import { BoardService } from "./services/board-service.js";
import { EventBus } from "./ws/event-bus.js";

async function main(): Promise<void> {
  const store = new StateStore(DATA_DIR);
  const events = new EventBus();
  const service = new BoardService(store, events);
  await service.initialize();

  const app = createApp(service);
  const honoListener = getRequestListener(app.fetch);
  const server = createServer();
  const frontend = await createFrontendHandler(server);

  server.on("request", async (req, res) => {
    try {
      const handled = await frontend.handle(req, res);
      if (handled) {
        return;
      }

      await honoListener(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : String(error)
            }
          })
        );
      }
    }
  });

  server.listen(DEFAULT_PORT, "127.0.0.1", () => {
    console.log(`Workhorse listening on http://127.0.0.1:${DEFAULT_PORT}`);
  });

  server.on("listening", () => {
    events.attach(server as unknown as Server);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
