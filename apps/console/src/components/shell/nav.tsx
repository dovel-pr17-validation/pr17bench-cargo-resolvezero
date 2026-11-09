import { Link } from '@tanstack/react-router'
import { Activity, Cable, FileText, House, KeyRound, Layers3, ListFilter, Monitor, Settings } from 'lucide-react'
import type { ReactNode } from 'react'

export type NavItem = {
  label: string
  to: string
  icon: ReactNode
  badge?: string
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: 'Network',
    items: [
      { label: 'Overview', to: '/', icon: <Activity size={16} /> },
      { label: 'Devices', to: '/devices', icon: <Monitor size={16} /> },
      { label: 'Local DNS', to: '/local-dns', icon: <House size={16} /> },
      { label: 'Setup', to: '/setup', icon: <Cable size={16} /> },
    ],
  },
  {
    label: 'Protection',
    items: [
      { label: 'Rules', to: '/rules', icon: <ListFilter size={16} /> },
      { label: 'Blocklists', to: '/blocklists', icon: <Layers3 size={16} /> },
    ],
  },
  {
    label: 'Observe',
    items: [{ label: 'Logs', to: '/logs', icon: <FileText size={16} /> }],
  },
]

export const accountNav: NavItem[] = [
  { label: 'API keys', to: '/api-keys', icon: <KeyRound size={16} /> },
  { label: 'Settings', to: '/settings', icon: <Settings size={16} /> },
]

export function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={[
        'group flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-[7px] text-[12.5px] font-medium transition-colors',
        active
          ? 'bg-white/[0.09] text-[var(--sidebar-text)]'
          : 'text-[var(--sidebar-muted)] hover:bg-white/[0.05] hover:text-[var(--sidebar-text)]',
      ].join(' ')}
    >
      <span className={active ? 'text-[var(--brand)]' : 'text-[var(--sidebar-muted)] group-hover:text-[var(--sidebar-text)]'}>
        {item.icon}
      </span>
      <span>{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded-[var(--radius-sm)] bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-[var(--sidebar-text)] ring-1 ring-white/10">
          {item.badge}
        </span>
      ) : null}
    </Link>
  )
}
