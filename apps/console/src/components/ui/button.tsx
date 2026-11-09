import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { forwardRef, type ComponentPropsWithoutRef } from "react"

import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] font-medium leading-[1.1] tracking-[-0.005em] whitespace-nowrap transition-[background-color,border-color,color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "border border-[var(--brand)] bg-[var(--brand)] text-white shadow-[0_1px_2px_rgba(11,11,10,0.06)] hover:border-[var(--brand-strong)] hover:bg-[var(--brand-strong)]",
        secondary:
          "border border-[var(--line-strong)] bg-[var(--card)] text-[var(--ink)] hover:bg-[var(--paper-2)]",
      },
      size: {
        sm: "h-7 px-2.5 text-[11px]",
        md: "h-8 px-3 text-[12px]",
        lg: "h-9 px-4 text-[13px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
)

interface ButtonProps
  extends ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
