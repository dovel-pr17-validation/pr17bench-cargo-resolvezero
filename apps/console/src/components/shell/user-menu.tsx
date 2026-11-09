import { ChevronUp, LogOut } from 'lucide-react'
import { useState } from 'react'

import { authClient } from '../../lib/auth-client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

export function UserMenu({ name, image, email }: { name: string; image: string | null; email: string | null }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'RZ'

  async function signOut() {
    setPending(true)
    try {
      await authClient.signOut()
    } finally {
      window.location.assign('/login')
    }
  }

  return (
    <div className="relative border-t border-white/10">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-white/[0.05]"
          >
            {image ? (
              <img src={image} alt="" className="size-8 rounded-full object-cover ring-1 ring-white/15" referrerPolicy="no-referrer" />
            ) : (
              <span className="flex size-8 items-center justify-center rounded-full bg-[var(--brand)] text-[10px] font-semibold text-[var(--ink)]">
                {initials}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-[11px] font-medium text-[var(--sidebar-text)]">{name}</span>
              <span className="block truncate text-[10px] uppercase tracking-[0.06em] text-[var(--sidebar-muted)]">
                Personal workspace
              </span>
            </span>
            <ChevronUp
              size={14}
              className={`ml-auto text-[var(--sidebar-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="top" align="center" sideOffset={8} className="w-[224px] text-[var(--ink)]">
          <div className="border-b border-[var(--line)] px-3 py-2.5">
            <p className="truncate text-[11px] font-semibold">{name}</p>
            {email ? <p className="mt-0.5 truncate text-[10px] text-[var(--muted)]">{email}</p> : null}
          </div>
          <DropdownMenuItem
            onSelect={() => void signOut()}
            disabled={pending}
            className="text-[11px] text-[var(--ink)]"
          >
            <LogOut size={14} className="text-[var(--muted)]" />
            {pending ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
