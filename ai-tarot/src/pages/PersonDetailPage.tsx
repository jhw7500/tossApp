import { Button } from '@toss/tds-mobile'
import { useCallback, useEffect, useState } from 'react'
import type { BrowserService } from '../api/service.ts'
import type { Person, ReadingHistory, RelationshipType } from '../api/types.ts'
import { mergePage, updateCurrentScope } from '../features/pagination.ts'
import { errorMessage, formatDate } from './page-utils.ts'
import { ErrorState, LoadingState, PageIntro } from './shared.tsx'

type DetailState = {
  scope: string
  loading: boolean
  error: string
  person: Person | null
  history: ReadingHistory | null
  relationships: RelationshipType[]
  loadingMore: boolean
  moreError: string
}

const loadingState = (scope: string): DetailState => ({
  scope,
  loading: true,
  error: '',
  person: null,
  history: null,
  relationships: [],
  loadingMore: false,
  moreError: '',
})

export function PersonDetailPage({ personId, service, onEdit, onNewReading, onOpenReading }: { personId: string; service: BrowserService; onEdit: () => void; onNewReading: () => void; onOpenReading: (readingId: string) => void }) {
  const [state, setState] = useState<DetailState>(() => loadingState(personId))

  const load = useCallback(async () => {
    const scope = personId
    setState(loadingState(scope))
    try {
      const [person, history, catalog] = await Promise.all([
        service.getPerson(scope),
        service.listReadings(scope),
        service.listRelationships(),
      ])
      setState(current => updateCurrentScope(current, scope, () => ({
        scope,
        loading: false,
        error: '',
        person,
        history,
        relationships: catalog.items,
        loadingMore: false,
        moreError: '',
      })))
    } catch (caught) {
      setState(current => updateCurrentScope(current, scope, value => ({ ...value, loading: false, error: errorMessage(caught) })))
    }
  }, [personId, service])

  const loadMore = useCallback(async () => {
    if (state.scope !== personId || !state.history?.nextCursor || state.loadingMore) return
    const scope = personId
    const cursor = state.history.nextCursor
    setState(current => updateCurrentScope(current, scope, value => ({ ...value, loadingMore: true, moreError: '' })))
    try {
      const page = await service.listReadings(scope, cursor)
      setState(current => updateCurrentScope(current, scope, value => value.history ? { ...value, history: mergePage(value.history, page) } : value))
    } catch (caught) {
      setState(current => updateCurrentScope(current, scope, value => ({ ...value, moreError: errorMessage(caught) })))
    } finally {
      setState(current => updateCurrentScope(current, scope, value => ({ ...value, loadingMore: false })))
    }
  }, [personId, service, state.history?.nextCursor, state.loadingMore, state.scope])

  useEffect(() => { void load() }, [load])

  if (state.scope !== personId || state.loading) return <><PageIntro title="인연 정보" /><div className="content-stack"><LoadingState /></div></>
  if (state.error || !state.person || !state.history) return <><PageIntro title="인연 정보" /><div className="content-stack"><ErrorState message={state.error || '인연을 찾지 못했어요.'} onRetry={() => void load()} /></div></>

  const { person, history, relationships } = state
  return <><PageIntro eyebrow={relationships.find(item => item.code === person.relationshipCode)?.label ?? '인연'} title={person.nickname} description={person.currentSituation || '현재 상황이 아직 기록되지 않았어요.'} /><div className="content-stack">
    <div className="button-row"><Button display="full" variant="weak" onClick={onEdit}>정보 수정</Button><Button display="full" onClick={onNewReading}>새 리딩</Button></div>
    <section><div className="section-heading"><h2>이전 리딩</h2><span>{person.readingCount}회 성공</span></div>{history.items.length === 0 ? <div className="state-card"><p>아직 리딩 기록이 없어요. 첫 질문을 시작해 보세요.</p></div> : <div className="list-stack"><div className="list">{history.items.map(item => <button className="list-row" key={item.id} onClick={() => onOpenReading(item.id)}><span><strong>{item.question}</strong><small>{item.summary || (item.status === 'FAILED' ? '생성 실패' : '결과 생성 중')}</small></span><span className={`status status--${item.status.toLowerCase()}`}>{formatDate(item.createdAt)}</span></button>)}</div>{state.moreError && <div className="error-message" role="alert">{state.moreError}</div>}{history.nextCursor && <Button display="full" variant="weak" loading={state.loadingMore} disabled={state.loadingMore} onClick={() => void loadMore()}>리딩 더 보기</Button>}</div>}</section>
  </div></>
}
