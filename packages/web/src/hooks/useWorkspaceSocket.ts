import { useEffect, useRef } from "react";

import type { ServerEvent } from "@workhorse/contracts";

interface Params {
  onEvent(event: ServerEvent): void;
}

export function useWorkspaceSocket({ onEvent }: Params) {
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

      socket.onmessage = (event) => {
        try {
          onEventRef.current(JSON.parse(event.data as string) as ServerEvent);
        } catch {
          // Ignore malformed socket frames.
        }
      };

      socket.onclose = () => {
        if (!active) {
          return;
        }

        retryTimer = window.setTimeout(connect, 1500);
      };
    }

    connect();

    return () => {
      active = false;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, []);
}
