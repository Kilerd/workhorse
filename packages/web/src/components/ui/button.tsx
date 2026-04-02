import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-none border text-[0.75rem] font-normal text-foreground outline-none transition-[border-color,background-color,transform,opacity] hover:-translate-y-px disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-[rgba(73,214,196,0.26)] bg-accent text-foreground hover:border-[var(--border-strong)]",
        secondary:
          "border-border bg-background text-foreground hover:border-[var(--border-strong)]",
        destructive:
          "border-[rgba(240,113,113,0.28)] bg-[rgba(240,113,113,0.16)] text-foreground hover:border-[var(--border-strong)]"
      },
      size: {
        default: "min-h-7 px-2.5",
        icon: "size-7 p-0"
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
