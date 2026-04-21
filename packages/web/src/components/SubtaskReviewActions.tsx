import { cn } from "@/lib/utils";

interface Props {
  canApprove?: boolean;
  showApprove?: boolean;
  showReject?: boolean;
  showRetry?: boolean;
  showCancel?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onApprove?(): void;
  onReject?(): void;
  onRetry?(): void;
  onCancel?(): void;
}

const baseButtonClass =
  "inline-flex min-h-9 items-center justify-center rounded-full border px-2.5 text-[0.74rem] font-semibold transition-[border-color,background-color,transform] hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0";

export function SubtaskReviewActions({
  canApprove = false,
  showApprove = true,
  showReject = true,
  showRetry = true,
  showCancel = false,
  compact = false,
  disabled = false,
  onApprove,
  onReject,
  onRetry,
  onCancel
}: Props) {
  const sizeClass = compact ? "min-h-7 px-2 text-[0.64rem]" : "";

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", compact && "gap-1")}>
      {showApprove ? (
        <button
          type="button"
          className={cn(
            baseButtonClass,
            sizeClass,
            "border-[rgba(47,117,88,0.28)] bg-[rgba(47,117,88,0.08)] text-[var(--success)] hover:border-[rgba(47,117,88,0.42)] hover:bg-[rgba(47,117,88,0.14)]"
          )}
          disabled={!canApprove || disabled}
          onClick={(event) => {
            event.stopPropagation();
            onApprove?.();
          }}
        >
          Approve
        </button>
      ) : null}
      {showReject ? (
        <button
          type="button"
          className={cn(
            baseButtonClass,
            sizeClass,
            "border-[rgba(181,74,74,0.28)] bg-[rgba(181,74,74,0.08)] text-[var(--danger)] hover:border-[rgba(181,74,74,0.42)] hover:bg-[rgba(181,74,74,0.14)]"
          )}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onReject?.();
          }}
        >
          Reject
        </button>
      ) : null}
      {showRetry ? (
        <button
          type="button"
          className={cn(
            baseButtonClass,
            sizeClass,
            "border-border bg-[var(--surface-soft)] text-foreground hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
          )}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onRetry?.();
          }}
        >
          Retry
        </button>
      ) : null}
      {showCancel ? (
        <button
          type="button"
          className={cn(
            baseButtonClass,
            sizeClass,
            "border-[rgba(166,109,26,0.28)] bg-[rgba(166,109,26,0.08)] text-[var(--warning)] hover:border-[rgba(166,109,26,0.4)] hover:bg-[rgba(166,109,26,0.14)]"
          )}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onCancel?.();
          }}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}
