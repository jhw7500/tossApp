import type { Page } from '@playwright/test'

export const appOrigin = 'http://127.0.0.1:4173'

export async function installNetworkIsolation(page: Page) {
  const blockedRequests: string[] = []
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const isApiPath = url.pathname === '/api' || url.pathname.startsWith('/api/')
    const isAppResource = url.origin === appOrigin && !isApiPath
    const isMockedApi = url.origin === appOrigin && url.pathname.startsWith('/api/v1/')
    if (isAppResource || isMockedApi) return route.fallback()
    blockedRequests.push(url.href)
    return route.abort('blockedbyclient')
  })
  return blockedRequests
}
