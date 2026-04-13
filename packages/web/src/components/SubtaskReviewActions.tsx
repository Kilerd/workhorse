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
  "inline-flex min-h-7 items-center justify-center rounded-none border px-2.5 text-[0.72rem] transition-[border-color,background-color,transform] hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0";

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
  const sizeClass = compact ? "min-h-6 px-2 text-[0.64rem]" : "";

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", compact && "gap-1")}>
      {showApprove ? (
        <button
          type="button"
          className={cn(
            baseButtonClass,
            sizeClass,
            "border-[rgba(99,216,158,0.28)] bg-[rgba(99,216,158,0.12)] text-[var(--success)] hover:border-[rgba(99,216,158,0.42)] hover:bg-[rgba(99,216,158,0.18)]"
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
            "border-[rgba(240,113,113,0.28)] bg-[rgba(240,113,113,0.1)] text-[var(--danger)] hover:border-[rgba(240,113,113,0.42)] hover:bg-[rgba(240,113,113,0.16)]"
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
            "border-[rgba(242,195,92,0.28)] bg-[rgba(242,195,92,0.1)] text-[var(--warning)] hover:border-[rgba(242,195,92,0.4)] hover:bg-[rgba(242,195,92,0.16)]"
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
