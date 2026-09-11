import { Button } from '@toss/tds-mobile'
import { useCallback, useEffect, useState } from 'react'
import type { BrowserService } from '../api/service.ts'
import type { Person, RelationshipType } from '../api/types.ts'
import { mergePage } from '../features/pagination.ts'
import { errorMessage, formatDate } from './page-utils.ts'
import { ErrorState, LoadingState, PageIntro } from './shared.tsx'

export function PersonsPage({ service, onNew, onOpen }: { service: BrowserService; onNew: () => void; onOpen: (personId: string) => void }) {
  const [state, setState] = useState<{ loading: boolean; error: string; items: Person[] }>({ loading: true, error: '', items: [] })
  const [relationships, setRelationships] = useState<RelationshipType[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const load = useCallback(async () => {
    setState(value => ({ ...value, loading: true, error: '' }))
    setMoreError('')
    try { const [people, catalog] = await Promise.all([service.listPersons(), service.listRelationships()]); setRelationships(catalog.items); setNextCursor(people.nextCursor); setState({ loading: false, error: '', items: people.items }) }
    catch (error) { setNextCursor(null); setState({ loading: false, error: errorMessage(error), items: [] }) }
  }, [service])
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true); setMoreError('')
    try {
      const page = await service.listPersons(nextCursor)
      setState(value => ({ ...value, items: mergePage({ items: value.items, nextCursor }, page).items }))
      setNextCursor(page.nextCursor)
    } catch (error) { setMoreError(errorMessage(error)) }
    finally { setLoadingMore(false) }
  }, [loadingMore, nextCursor, service])
  useEffect(() => { void load() }, [load])
  return <><PageIntro title="내 인연" description="인연별로 질문과 리딩 기록을 차곡차곡 남겨 보세요." /><div className="content-stack">
    <Button display="full" onClick={onNew}>새 인연 등록</Button>
    {state.loading ? <LoadingState /> : state.error ? <ErrorState message={state.error} onRetry={() => void load()} /> : state.items.length === 0 ? <section className="state-card"><h2>등록된 인연이 없어요</h2><p>먼저 한 사람을 등록하면 리딩을 시작할 수 있어요.</p></section> : <div className="list-stack"><section className="list" aria-label="인연 목록">{state.items.map(person => <button className="list-row" key={person.id} onClick={() => onOpen(person.id)}><span><strong>{person.nickname}</strong><small>{relationships.find(item => item.code === person.relationshipCode)?.label ?? '관계 정보'}</small></span><span className="list-meta">성공 리딩 {person.readingCount}회<br />최근 {formatDate(person.lastReadingAt)}</span></button>)}</section>{moreError && <div className="error-message" role="alert">{moreError}</div>}{nextCursor && <Button display="full" variant="weak" loading={loadingMore} disabled={loadingMore} onClick={() => void loadMore()}>인연 더 보기</Button>}</div>}
  </div></>
}
