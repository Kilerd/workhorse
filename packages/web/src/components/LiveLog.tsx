import { useMemo } from "react";
import type { Run, Task } from "@workhorse/contracts";

interface Props {
  task: Task;
  activeRun: Run | null;
  liveLog: string;
  runLog: string;
}

export function LiveLog({ task, activeRun, liveLog, runLog }: Props) {
  const content = useMemo(() => {
    const combined = `${runLog}${liveLog}`;
    return combined.trim().length > 0 ? combined : "Logs will appear here when a run starts.";
  }, [liveLog, runLog]);

  return (
    <div className="details-body">
      <section className="details-section">
        <h3>Current run</h3>
        <div className="active-run">
          <div>
            <strong>{activeRun ? activeRun.status : "idle"}</strong>
            <p>{activeRun ? activeRun.id : "No active run"}</p>
          </div>
          <div className="muted">{task.runnerType}</div>
        </div>
      </section>
      <section className="details-section">
        <h3>Live log</h3>
        <pre className="log-viewer">{content}</pre>
      </section>
    </div>
  );
}
