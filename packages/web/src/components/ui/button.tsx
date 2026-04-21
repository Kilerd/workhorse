import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius)] border border-transparent text-[0.78rem] font-[510] text-foreground outline-none backdrop-blur-xl transition-[border-color,background-color,color,transform,opacity] hover:-translate-y-px focus-visible:border-[var(--accent)] disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-[rgba(113,112,255,0.44)] bg-[var(--accent)] text-[var(--accent-foreground)] hover:border-[rgba(113,112,255,0.64)] hover:bg-[var(--accent-strong)]",
        secondary:
          "border-border bg-[var(--surface-soft)] text-[var(--muted-strong)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] hover:text-foreground",
        destructive:
          "border-[rgba(239,98,108,0.34)] bg-[rgba(239,98,108,0.12)] text-[var(--danger)] hover:border-[rgba(239,98,108,0.54)] hover:bg-[rgba(239,98,108,0.18)]"
      },
      size: {
        default: "min-h-9 px-3.5",
        sm: "min-h-8 px-2.5 text-[0.72rem]",
        icon: "size-8 p-0"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
