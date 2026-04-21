import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "flex min-h-9 w-full min-w-0 appearance-none rounded-[var(--radius)] border border-input bg-[var(--bg-elevated)] px-3 py-2 pr-8 text-[0.86rem] text-[var(--muted-strong)] outline-none transition-[border-color,background-color,opacity] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:border-[var(--accent)] focus-visible:bg-[var(--panel)]",
        className
      )}
      {...props}
    />
  );
}

export { NativeSelect };
