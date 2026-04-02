import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "flex min-h-9 w-full min-w-0 rounded-none border border-input bg-background px-2.5 py-2 text-[0.82rem] text-foreground outline-none transition-[border-color,background-color,opacity] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:border-[var(--border-strong)] focus-visible:bg-[var(--bg-elevated)]",
        className
      )}
      {...props}
    />
  );
}

export { NativeSelect };
