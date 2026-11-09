import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown } from "lucide-react"
import { forwardRef, type ComponentPropsWithoutRef } from "react"

import { cn } from "../../lib/utils"

const Select = SelectPrimitive.Root
const SelectGroup = SelectPrimitive.Group
const SelectValue = SelectPrimitive.Value

const SelectTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "rz-input flex items-center justify-between gap-2 text-left data-[placeholder]:text-[var(--muted)]",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown size={14} className="shrink-0 text-[var(--muted)]" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={4}
      className={cn(
        "relative z-50 max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[var(--radius)] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-pop)]",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--paper-2)]",
      className,
    )}
    {...props}
  >
    <span className="flex size-4 shrink-0 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check size={12} className="text-[var(--brand)]" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName

export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue }
