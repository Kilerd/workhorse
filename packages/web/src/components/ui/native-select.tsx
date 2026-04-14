import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "flex min-h-11 w-full min-w-0 rounded-[var(--radius)] border border-input bg-[var(--bg-elevated)] px-4 py-2.5 text-[0.95rem] text-foreground outline-none transition-[border-color,background-color,box-shadow,opacity] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:border-[var(--accent)] focus-visible:bg-[var(--panel)] focus-visible:shadow-[0_0_0_3px_rgba(255,79,0,0.08)]",
        className
      )}
      {...props}
    />
  );
}

export { NativeSelect };
