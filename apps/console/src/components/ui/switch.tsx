import * as SwitchPrimitive from "@radix-ui/react-switch"
import { forwardRef, type ComponentPropsWithoutRef } from "react"

import { cn } from "../../lib/utils"

const Switch = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "relative inline-flex h-4 w-8 shrink-0 items-center rounded-full border transition-colors data-[state=checked]:border-[var(--ink)] data-[state=checked]:bg-[var(--ink)] data-[state=unchecked]:border-[var(--line-strong)] data-[state=unchecked]:bg-transparent",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block size-2.5 rounded-full bg-[var(--muted)] transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-[var(--card)] data-[state=unchecked]:translate-x-[2px]" />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch }
