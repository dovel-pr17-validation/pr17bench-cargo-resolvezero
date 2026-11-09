import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Braces, LogOut, ShieldCheck } from 'lucide-react'
import { useEffect } from 'react'

import logo from '../assets/logo-square.svg'
import { authClient } from '../lib/auth-client'
import type { SessionUser } from '../server/auth'
import { accountNav, navGroups, SidebarLink } from './shell/nav'
import { ProfileMenu } from './shell/profile-menu'
import { TimeZoneMenu } from './shell/timezone-menu'
import { UserMenu } from './shell/user-menu'
import { getOverview } from '../server/dashboard'

export function AppShell({ session }: { session: SessionUser | null }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { data } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })

  // Persist the server's deterministic fallback so later reads and mutations
  // stay on the same profile even before the user opens the switcher.
  useEffect(() => {
    const profileId = data?.profileId
    if (!profileId) return
    const current = document.cookie.match(/(?:^|;\s*)rz_profile_id=([^;]+)/)?.[1]
    if (current === profileId) return
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `rz_profile_id=${encodeURIComponent(profileId)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
  }, [data?.profileId])

  const deviceCount = data ? Math.max(data.activeDevices, data.topClients.length) : 0
  const queriesLabel = data
    ? new Intl.NumberFormat('en-GB', { notation: 'compact' }).format(data.totalQueries)
    : '—'
  const blockRate = data ? (data.blockRatio * 100).toFixed(1) : '—'
  const edgeHealthy = data?.edge.ok
  const viewerName = session?.name ?? ''
  const viewerImage = session?.image ?? null
  const viewerEmail = session?.email ?? null
  const profileLabel = data?.profileName
    ? data.profileName.charAt(0).toUpperCase() + data.profileName.slice(1)
    : 'Loading…'
  const groups = navGroups.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.label === 'Devices' && deviceCount > 0 ? { ...item, badge: String(deviceCount) } : item,
    ),
  }))

  async function signOut() {
    await authClient.signOut()
    window.location.assign('/login')
  }

  const mobileItems = [...groups.flatMap((group) => group.items), ...accountNav]

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)]">
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-3 border-b border-[var(--line)] bg-[var(--card)]/95 pl-3 pr-4 backdrop-blur-xl sm:pr-6">
        <Link to="/" aria-label="ResolveZero home" className="flex shrink-0 items-center">
          <img src={logo} alt="" className="size-9 shrink-0 sm:size-10" />
        </Link>

        <ProfileMenu profiles={data?.profiles ?? []} activeId={data?.profileId ?? ''} label={profileLabel} loading={!data} />

        <div className="ml-auto flex items-center gap-2">
          <TimeZoneMenu />
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            title="Open the API reference"
            className="hidden h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--card)] px-3 text-[11px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)] md:inline-flex"
          >
            <Braces size={12} className="text-[var(--brand)]" />
            API docs
          </a>
        </div>
      </header>

      <nav className="fixed inset-x-0 top-16 z-30 flex h-10 items-center overflow-x-auto border-b border-white/10 bg-[var(--sidebar)] px-2 lg:hidden">
        {mobileItems.map((item) => {
          const active = pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to))
          return (
            <Link
              key={item.to}
              to={item.to}
              className={[
                'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.06em] transition-colors [&_svg]:size-3',
                active
                  ? 'border-[var(--brand)] text-[var(--sidebar-text)] [&_svg]:text-[var(--brand)]'
                  : 'border-transparent text-[var(--sidebar-muted)] [&_svg]:text-[var(--sidebar-muted)]',
              ].join(' ')}
            >
              {item.icon}
              {item.label}
            </Link>
          )
        })}
        {session ? (
          <button
            type="button"
            onClick={() => void signOut()}
            className="ml-auto flex shrink-0 items-center gap-1.5 border-l border-white/10 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--sidebar-muted)]"
          >
            <LogOut size={11} /> Sign out
          </button>
        ) : null}
      </nav>

      <aside className="fixed bottom-0 left-0 top-16 z-30 hidden w-[248px] flex-col border-r border-white/10 bg-[var(--sidebar)] text-[var(--sidebar-text)] lg:flex">
        <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 pb-4 pt-6">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-2.5 pb-2 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--sidebar-muted)]/80">
                {group.label}
              </p>
              {group.items.map((item) => (
                <SidebarLink
                  key={item.label}
                  item={item}
                  active={pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to))}
                />
              ))}
            </div>
          ))}
        </nav>

        <div className="px-3 pb-3">
          <div className="rounded-[var(--radius)] border border-white/10 bg-white/[0.04] p-3.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.06em]">
                <span
                  className={[
                    'size-1.5 rounded-full',
                    edgeHealthy === false ? 'bg-[var(--brand)]' : 'bg-[var(--green)]',
                  ].join(' ')}
                />
                {edgeHealthy === false ? 'Edge unavailable' : 'Protection active'}
              </span>
              <ShieldCheck size={14} className="text-[var(--lime)]" />
            </div>
            <p className="mt-2.5 text-[11px] leading-5 text-[var(--sidebar-muted)]">
              {data ? `${queriesLabel} queries in the last 24 hours.` : 'Loading live DNS data…'}
            </p>
            <div className="mt-2.5 flex items-center justify-between border-t border-white/10 pt-2.5 text-[10px] uppercase tracking-[0.06em] text-[var(--sidebar-muted)]">
              <span>
                {deviceCount} {deviceCount === 1 ? 'device' : 'devices'}
              </span>
              <span className="rz-mono text-[var(--sidebar-text)]">{blockRate}% blocked</span>
            </div>
          </div>

          <p className="px-2.5 pb-1.5 pt-5 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--sidebar-muted)]/80">
            Account
          </p>
          {accountNav.map((item) => (
            <SidebarLink key={item.label} item={item} active={pathname === item.to} />
          ))}
        </div>

        {session ? <UserMenu name={viewerName} image={viewerImage} email={viewerEmail} /> : null}
      </aside>

      <div className="pt-[6.5rem] lg:pl-[248px] lg:pt-16">
        <main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-8 sm:py-9">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
