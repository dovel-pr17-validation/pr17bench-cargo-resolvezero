import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { Ban, FileText, House } from 'lucide-react'
import type { ReactNode } from 'react'

import logo from '../assets/logo-square.svg'
import { SignInCard } from '../components/auth/sign-in-card'
import { getSession } from '../server/auth'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const session = await getSession()
    if (session) throw redirect({ to: '/' })
  },
  component: LoginPage,
})

function Proof({ index, icon, title, detail }: { index: string; icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="grid grid-cols-[2.25rem_1fr] gap-3 border-t border-white/15 py-4">
      <span className="rz-mono pt-0.5 text-[9px] text-[var(--brand)]">{index}</span>
      <div>
        <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sidebar-text)]">
          <span className="text-[var(--sidebar-muted)]">{icon}</span>
          {title}
        </p>
        <p className="mt-1 text-[11px] leading-5 text-[var(--sidebar-muted)]">{detail}</p>
      </div>
    </div>
  )
}

function LoginPage() {
  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)] lg:grid lg:grid-cols-2">
      <section className="rz-mesh relative flex flex-col overflow-hidden px-5 py-5 text-[var(--sidebar-text)] lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-16 -right-10 select-none rz-font-display text-[18rem] font-extrabold leading-none tracking-[-0.09em] text-white/[0.035] lg:text-[24rem]"
        >
          RØ
        </div>

        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logo} alt="ResolveZero" className="size-10 shrink-0 invert" />
            <span className="rz-font-display text-[17px] font-semibold tracking-[-0.03em] lg:hidden">
              ResolveZero
            </span>
          </div>
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--sidebar-muted)]">
            DNS / Privacy
          </span>
        </div>

        <div className="relative z-10 hidden flex-1 flex-col justify-center py-16 lg:flex">
          <p className="mb-5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--sidebar-muted)]">
            Open-source DNS firewall
          </p>
          <h1 className="rz-hero-title max-w-[560px]">ResolveZero</h1>
          <p className="mt-6 max-w-[430px] text-[16px] leading-7 text-[var(--sidebar-muted)]">
            Your DNS. Your rules. Filter at the edge, resolve local names, and keep the logs in storage you own.
          </p>

          <div className="mt-10 max-w-[430px]">
            <Proof
              index="01"
              icon={<Ban size={12} />}
              title="Filter"
              detail="Block trackers before they connect."
            />
            <Proof
              index="02"
              icon={<House size={12} />}
              title="Resolve"
              detail="Answer .lan names locally, before blocklists or upstream."
            />
            <Proof
              index="03"
              icon={<FileText size={12} />}
              title="Own"
              detail="Compressed query history in your bucket, not someone else's dashboard."
            />
          </div>
        </div>

        <p className="relative z-10 hidden border-t border-white/15 pt-4 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--sidebar-muted)] lg:block">
          Private by default · No third-party DNS · Self-hosted friendly
        </p>
      </section>

      <section className="relative flex min-h-[calc(100vh-5rem)] flex-col bg-[var(--paper)] px-5 pb-6 pt-5 sm:px-8 lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <main className="flex flex-1 items-center justify-center py-10 lg:py-14">
          <div className="w-full max-w-[420px]">
            <SignInCard />

            <p className="mt-4 text-center text-[11px] leading-5 text-[var(--muted)]">
              Don’t have an account yet?{' '}
              <Link
                to="/waitlist"
                className="font-semibold text-[var(--ink)] underline decoration-[var(--brand)] decoration-2 underline-offset-4 hover:text-[var(--brand)]"
              >
                Click here
              </Link>
            </p>
          </div>
        </main>

        <footer className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
          Self-hosted friendly · open-source console
        </footer>
      </section>
    </div>
  )
}
