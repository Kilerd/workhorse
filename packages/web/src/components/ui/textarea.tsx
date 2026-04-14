import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[120px] w-full min-w-0 rounded-[var(--radius)] border border-input bg-[var(--bg-elevated)] px-4 py-3 text-[0.95rem] text-foreground outline-none transition-[border-color,background-color,box-shadow,opacity] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-55 focus-visible:border-[var(--accent)] focus-visible:bg-[var(--panel)] focus-visible:shadow-[0_0_0_3px_rgba(255,79,0,0.08)]",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
