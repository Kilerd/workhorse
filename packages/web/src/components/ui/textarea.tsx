import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[110px] w-full min-w-0 rounded-none border border-input bg-background px-2.5 py-2 text-[0.82rem] text-foreground outline-none transition-[border-color,background-color,opacity] placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-55 focus-visible:border-[var(--border-strong)] focus-visible:bg-[var(--bg-elevated)]",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
