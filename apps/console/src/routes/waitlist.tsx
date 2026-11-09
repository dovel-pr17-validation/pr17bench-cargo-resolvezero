import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight, CheckCircle2, Server } from 'lucide-react'
import { useState } from 'react'

import logo from '../assets/logo-square.svg'
import { Button } from '../components/ui/button'
import { joinWaitlist } from '../server/waitlist'

export const Route = createFileRoute('/waitlist')({ component: WaitlistPage })

function WaitlistPage() {
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')

  const join = useMutation({
    mutationFn: () => joinWaitlist({ data: { email, website } }),
  })

  const submitted = join.isSuccess
  const already = join.data?.already === true

  return (
    <div className="flex min-h-screen flex-col bg-[var(--paper)] text-[var(--ink)]">
      <header className="border-b border-[var(--line)] bg-[var(--card)]">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link to="/login" className="flex items-center gap-2.5" aria-label="ResolveZero sign in">
            <img src={logo} alt="" className="size-9" />
            <span className="text-[13px] font-semibold tracking-[-0.01em]">ResolveZero</span>
          </Link>
          <Button asChild variant="secondary" size="sm">
            <Link to="/login">
              <ArrowLeft size={12} /> Back to sign in
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-12 sm:px-8 lg:py-16">
        <p className="rz-eyebrow">Early access</p>
        <h1 className="rz-page-title mt-4 max-w-[640px]">Hosted access is opening gradually.</h1>
        <p className="mt-4 max-w-[560px] text-[13px] leading-6 text-[var(--muted)]">
          Leave your email and we&apos;ll send one message when your invite is ready. One row per address — no newsletter,
          no marketing list.
        </p>

        <div className="mt-9 grid gap-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="rz-card p-6">
            {submitted ? (
              <div className="flex h-full flex-col justify-center py-2">
                <span className="flex size-9 items-center justify-center rounded-full bg-[var(--green-soft)] text-[var(--green)]">
                  <CheckCircle2 size={18} />
                </span>
                <h2 className="mt-4 text-[15px] font-semibold">
                  {already ? 'You are already on the list' : 'You are on the list'}
                </h2>
                <p className="mt-1.5 text-[12px] leading-6 text-[var(--muted)]">
                  {already
                    ? 'That address was added earlier. We will email it when an invite is available.'
                    : `We will email ${email.trim().toLowerCase()} when hosted access opens for you.`}
                </p>
              </div>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!join.isPending) join.mutate()
                }}
              >
                <div>
                  <h2 className="text-[15px] font-semibold">Join the waitlist</h2>
                  <p className="mt-1 text-[11px] leading-5 text-[var(--muted)]">
                    Hosted accounts are invite-only while we onboard the first networks.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="waitlist-email"
                    className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]"
                  >
                    Email address
                  </label>
                  <input
                    id="waitlist-email"
                    type="email"
                    required
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    className="rz-input w-full"
                  />
                </div>

                {/* Honeypot: hidden from people, irresistible to bots. */}
                <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
                  <label htmlFor="waitlist-website">Website</label>
                  <input
                    id="waitlist-website"
                    tabIndex={-1}
                    autoComplete="off"
                    value={website}
                    onChange={(event) => setWebsite(event.target.value)}
                  />
                </div>

                <Button type="submit" disabled={join.isPending || !email.trim()}>
                  {join.isPending ? 'Adding…' : 'Join the waitlist'}
                </Button>

                {join.isError ? (
                  <p role="alert" className="text-[11px] text-[var(--danger)]">
                    {join.error.message}
                  </p>
                ) : null}
              </form>
            )}
          </div>

          <div className="rz-mesh rz-card flex flex-col border-white/10 p-6 text-[var(--sidebar-text)]">
            <span className="flex size-9 items-center justify-center rounded-[var(--radius-sm)] bg-white/10 text-[var(--lime)]">
              <Server size={16} />
            </span>
            <h2 className="mt-4 text-[15px] font-semibold">Prefer to run it yourself?</h2>
            <p className="mt-1.5 text-[12px] leading-6 text-[var(--sidebar-muted)]">
              The edge and console are self-hostable today. Bring Postgres and a GitHub OAuth app; the README covers the
              rest. No waitlist.
            </p>
            <div className="mt-5 lg:mt-auto lg:pt-5">
              <Button asChild variant="secondary" className="w-full border-white/20 bg-white/5 text-[var(--sidebar-text)] hover:bg-white/10 sm:w-auto">
                <a href="https://github.com/digitalmio/resolvezero" target="_blank" rel="noreferrer">
                  <ArrowUpRight size={13} /> View on GitHub
                </a>
              </Button>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-[var(--line)]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-5 py-4 text-[10px] uppercase tracking-[0.06em] text-[var(--muted)] sm:px-8">
          <span>Self-hosted friendly · open-source console</span>
          <span>DNS / Privacy</span>
        </div>
      </footer>
    </div>
  )
}
