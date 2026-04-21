import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[112px] w-full min-w-0 rounded-[var(--radius)] border border-input bg-[var(--bg-elevated)] px-3 py-2.5 text-[0.86rem] text-[var(--muted-strong)] outline-none transition-[border-color,background-color,opacity] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-55 focus-visible:border-[var(--accent)] focus-visible:bg-[var(--panel)]",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
