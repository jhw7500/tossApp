import { graniteEvent } from '@apps-in-toss/web-framework'
import { Button } from '@toss/tds-mobile'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { ClientConfigurationError, createBrowserService } from './api/service.ts'
import type { AcceptedReading } from './api/types.ts'
import {
  hasAppHistoryPredecessor,
  subscribeNativeBack,
  withAppHistoryPredecessor,
} from './features/native-back.ts'
import { useSafeArea } from './hooks/use-safe-area.ts'
import { PersonDetailPage } from './pages/PersonDetailPage.tsx'
import { PersonFormPage } from './pages/PersonFormPage.tsx'
import { PersonsPage } from './pages/PersonsPage.tsx'
import { ReadingPage } from './pages/ReadingPage.tsx'
import { ReadingSetupPage } from './pages/ReadingSetupPage.tsx'
import { errorMessage } from './pages/page-utils.ts'
import './App.css'

type Route =
  | { name: 'persons' }
  | { name: 'person-new' }
  | { name: 'person'; personId: string }
  | { name: 'person-edit'; personId: string }
  | { name: 'reading-new'; personId: string }
  | { name: 'reading'; personId: string; readingId: string }

const readRoute = (): Route => {
  const params = new URLSearchParams(location.search)
  const personId = params.get('person')
  const readingId = params.get('reading')
  if (personId === 'new') return { name: 'person-new' }
  if (!personId) return { name: 'persons' }
  if (readingId === 'new') return { name: 'reading-new', personId }
  if (readingId) return { name: 'reading', personId, readingId }
  if (params.get('edit') === '1') return { name: 'person-edit', personId }
  return { name: 'person', personId }
}

const hrefFor = (route: Route): string => {
  if (route.name === 'persons') return location.pathname
  if (route.name === 'person-new') return `${location.pathname}?person=new`
  if (route.name === 'person') return `${location.pathname}?person=${encodeURIComponent(route.personId)}`
  if (route.name === 'person-edit') return `${location.pathname}?person=${encodeURIComponent(route.personId)}&edit=1`
  if (route.name === 'reading-new') return `${location.pathname}?person=${encodeURIComponent(route.personId)}&reading=new`
  return `${location.pathname}?person=${encodeURIComponent(route.personId)}&reading=${encodeURIComponent(route.readingId)}`
}

function App() {
  useSafeArea()
  const [route, setRoute] = useState<Route>(readRoute)
  const hasPreviousEntry = hasAppHistoryPredecessor(history.state)
  const [recovery, setRecovery] = useState<'checking' | 'idle' | 'uncertain'>('checking')
  const [recoveryMessage, setRecoveryMessage] = useState('')
  const serviceResult = useMemo(() => {
    try { return { service: createBrowserService(), error: null } }
    catch (error) { return { service: null, error: error instanceof ClientConfigurationError ? error.message : errorMessage(error) } }
  }, [])

  const navigate = useCallback((next: Route, replace = false) => {
    const nextHasPreviousEntry = replace ? hasAppHistoryPredecessor(history.state) : true
    history[replace ? 'replaceState' : 'pushState'](
      withAppHistoryPredecessor(history.state, nextHasPreviousEntry),
      '',
      hrefFor(next),
    )
    setRoute(next)
  }, [])

  useEffect(() => {
    const onPopState = () => setRoute(readRoute())
    addEventListener('popstate', onPopState)
    return () => removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => subscribeNativeBack({
    active: route.name !== 'persons',
    hasPreviousEntry,
    subscribe: (event, handlers) => graniteEvent.addEventListener(event, handlers),
    goBack: () => history.back(),
    goToRoot: () => navigate({ name: 'persons' }, true),
    onError: error => console.error('앱인토스 뒤로가기 이벤트를 처리하지 못했어요.', error),
  }), [hasPreviousEntry, navigate, route.name])

  const recover = useCallback(async () => {
    if (!serviceResult.service) return
    setRecovery('checking'); setRecoveryMessage('')
    try {
      const recovered = await serviceResult.service.resumePendingReading()
      setRecovery('idle')
      if (recovered) navigate({ name: 'reading', personId: recovered.personId, readingId: recovered.accepted.readingId }, true)
    } catch (error) { setRecovery('uncertain'); setRecoveryMessage(errorMessage(error)) }
  }, [navigate, serviceResult.service])

  useEffect(() => { void recover() }, [recover])

  if (serviceResult.error || !serviceResult.service) {
    return <main className="page centered-state"><section className="state-card" role="alert"><p className="eyebrow">tarororo</p><h1>지금은 서비스를 열 수 없어요</h1><p>{serviceResult.error}</p></section></main>
  }

  const service = serviceResult.service
  const openReading = (personId: string) => (accepted: AcceptedReading) => navigate({ name: 'reading', personId, readingId: accepted.readingId }, true)
  return <main className="page">
    {recovery === 'checking' && <div className="recovery-banner" role="status">접수 중이던 리딩을 확인하고 있어요.</div>}
    {recovery === 'uncertain' && <div className="recovery-banner recovery-banner--error" role="alert"><span>{recoveryMessage || '리딩 접수 여부를 확인하지 못했어요.'}</span><Button size="small" variant="weak" onClick={() => void recover()}>다시 확인</Button></div>}
    {recoveryMessage && recovery === 'idle' && <div className="recovery-banner" role="status">{recoveryMessage}</div>}
    {route.name === 'persons' && <PersonsPage service={service} onNew={() => navigate({ name: 'person-new' })} onOpen={personId => navigate({ name: 'person', personId })} />}
    {route.name === 'person-new' && <PersonFormPage service={service} onSaved={person => navigate({ name: 'person', personId: person.id }, true)} />}
    {route.name === 'person' && <PersonDetailPage personId={route.personId} service={service} onEdit={() => navigate({ name: 'person-edit', personId: route.personId })} onNewReading={() => navigate({ name: 'reading-new', personId: route.personId })} onOpenReading={readingId => navigate({ name: 'reading', personId: route.personId, readingId })} />}
    {route.name === 'person-edit' && <PersonFormPage personId={route.personId} service={service} onSaved={person => navigate({ name: 'person', personId: person.id }, true)} />}
    {route.name === 'reading-new' && <ReadingSetupPage personId={route.personId} service={service} onAccepted={openReading(route.personId)} onRecovered={recovered => navigate({ name: 'reading', personId: recovered.personId, readingId: recovered.accepted.readingId }, true)} />}
    {route.name === 'reading' && <ReadingPage readingId={route.readingId} service={service} onRetryAccepted={openReading(route.personId)} />}
  </main>
}

export default App
