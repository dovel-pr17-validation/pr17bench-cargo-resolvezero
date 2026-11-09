import { HeadContent, Outlet, Scripts, createRootRoute, redirect, useRouterState } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

import { AppShell } from '../components/app-shell'
import { getSession } from '../server/auth'
import appCss from '../styles.css?url'

const PUBLIC_PATHS = new Set(['/login', '/waitlist'])

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith('/api/')
}

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (isPublicPath(location.pathname)) return { session: null }
    const session = await getSession()
    if (!session) throw redirect({ to: '/login' })
    return { session }
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'ResolveZero' },
      { name: 'theme-color', content: '#f2efe6' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' },
      { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' },
      { rel: 'shortcut icon', href: '/favicon.ico' },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
})

function RootComponent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { session } = Route.useRouteContext()
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, refetchOnWindowFocus: false },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      {isPublicPath(pathname) ? <Outlet /> : <AppShell session={session} />}
    </QueryClientProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
