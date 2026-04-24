import type {
  CoordinatorRunHandle,
  CoordinatorRunInput,
  CoordinatorRunOutcome,
  CoordinatorOutputChunk,
  CoordinatorRunner
} from "./session-bridge.js";

/**
 * Placeholder CoordinatorRunner that accepts every input but does no real
 * agent work. Finishes successfully on the next tick so the thread's
 * `coordinator_state` flips idle and pending messages drain.
 *
 * Wired as the default until real claude-cli / codex-acp adapters land
 * (Spec 07e-2). Lets the new thread/plan/tool plumbing be exercised
 * end-to-end without a live model.
 */
export class NoopCoordinatorRunner implements CoordinatorRunner {
  public async resumeOrStart(
    input: CoordinatorRunInput
  ): Promise<CoordinatorRunHandle> {
    const chunkHandlers = new Set<(chunk: CoordinatorOutputChunk) => void>();
    const finishHandlers = new Set<(outcome: CoordinatorRunOutcome) => void>();
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      const outcome: CoordinatorRunOutcome = { status: "succeeded" };
      for (const h of finishHandlers) {
        try {
          h(outcome);
        } catch (error) {
          console.warn("[noop-runner] finish handler threw", error);
        }
      }
    };

    const handle: CoordinatorRunHandle = {
      runId: input.runId,
      onChunk(handler) {
        chunkHandlers.add(handler);
        return () => {
          chunkHandlers.delete(handler);
        };
      },
      onFinish(handler) {
        finishHandlers.add(handler);
        return () => {
          finishHandlers.delete(handler);
        };
      },
      async submitToolResult() {
        // No model waiting for a tool result — drop on the floor.
      },
      async cancel() {
        finish();
      }
    };

    console.log(
      `[noop-runner] stub run thread=${input.threadId} msgs=${input.appendMessages.length} tools=${input.tools.length}`
    );

    // Defer finish to the next tick so the caller can attach onFinish
    // listeners before we fire.
    setImmediate(finish);

    return handle;
  }
}
