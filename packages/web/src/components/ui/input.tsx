import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        "flex min-h-9 w-full min-w-0 rounded-[var(--radius)] border border-input bg-[var(--bg-elevated)] px-3 py-2 text-[0.86rem] text-[var(--muted-strong)] outline-none transition-[border-color,background-color,opacity] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-55 focus-visible:border-[var(--accent)] focus-visible:bg-[var(--panel)]",
        className
      )}
      {...props}
    />
  );
}

export { Input };
