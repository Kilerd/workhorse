import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-lg)] border text-[0.88rem] font-semibold text-foreground outline-none transition-[border-color,background-color,color,transform,opacity] hover:-translate-y-px disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] hover:border-[var(--accent-strong)] hover:bg-[var(--accent-strong)]",
        secondary:
          "border-border bg-[var(--surface-soft)] text-foreground hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]",
        destructive:
          "border-[rgba(181,74,74,0.3)] bg-[rgba(181,74,74,0.08)] text-[var(--danger)] hover:border-[rgba(181,74,74,0.52)] hover:bg-[rgba(181,74,74,0.14)]"
      },
      size: {
        default: "min-h-11 px-5",
        sm: "min-h-8 px-3 text-[0.82rem]",
        icon: "size-11 p-0"
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
