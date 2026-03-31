import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { DEFAULT_PORT, DATA_DIR } from "./config.js";
import { createApp } from "./app.js";
import { StateStore } from "./persistence/state-store.js";
import { BoardService } from "./services/board-service.js";
import { EventBus } from "./ws/event-bus.js";

async function main(): Promise<void> {
  const store = new StateStore(DATA_DIR);
  const events = new EventBus();
  const service = new BoardService(store, events);
  await service.initialize();

  const app = createApp(service);

  const server = serve(
    {
      fetch: app.fetch,
      port: DEFAULT_PORT
    },
    (info) => {
      console.log(`Workhorse runtime listening on http://127.0.0.1:${info.port}`);
    }
  );

  events.attach(server as unknown as Server);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
