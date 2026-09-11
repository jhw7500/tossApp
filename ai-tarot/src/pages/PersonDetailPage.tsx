import { Button } from '@toss/tds-mobile'
import { useCallback, useEffect, useState } from 'react'
import type { BrowserService } from '../api/service.ts'
import type { Person, ReadingHistory, RelationshipType } from '../api/types.ts'
import { mergePage } from '../features/pagination.ts'
import { errorMessage, formatDate } from './page-utils.ts'
import { ErrorState, LoadingState, PageIntro } from './shared.tsx'

export function PersonDetailPage({ personId, service, onEdit, onNewReading, onOpenReading }: { personId: string; service: BrowserService; onEdit: () => void; onNewReading: () => void; onOpenReading: (readingId: string) => void }) {
  const [person, setPerson] = useState<Person | null>(null); const [history, setHistory] = useState<ReadingHistory | null>(null)
  const [relationships, setRelationships] = useState<RelationshipType[]>([])
  const [loading, setLoading] = useState(true); const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false); const [moreError, setMoreError] = useState('')
  const load = useCallback(async () => { setLoading(true); setError(''); setMoreError(''); try { const [nextPerson, nextHistory, catalog] = await Promise.all([service.getPerson(personId), service.listReadings(personId), service.listRelationships()]); setPerson(nextPerson); setHistory(nextHistory); setRelationships(catalog.items) } catch (caught) { setError(errorMessage(caught)) } finally { setLoading(false) } }, [personId, service])
  const loadMore = useCallback(async () => {
    if (!history?.nextCursor || loadingMore) return
    const cursor = history.nextCursor
    setLoadingMore(true); setMoreError('')
    try {
      const page = await service.listReadings(personId, cursor)
      setHistory(value => value ? mergePage(value, page) : page)
    } catch (caught) { setMoreError(errorMessage(caught)) }
    finally { setLoadingMore(false) }
  }, [history?.nextCursor, loadingMore, personId, service])
  useEffect(() => { void load() }, [load])
  if (loading) return <><PageIntro title="인연 정보" /><div className="content-stack"><LoadingState /></div></>
  if (error || !person || !history) return <><PageIntro title="인연 정보" /><div className="content-stack"><ErrorState message={error || '인연을 찾지 못했어요.'} onRetry={() => void load()} /></div></>
  return <><PageIntro eyebrow={relationships.find(item => item.code === person.relationshipCode)?.label ?? '인연'} title={person.nickname} description={person.currentSituation || '현재 상황이 아직 기록되지 않았어요.'} /><div className="content-stack">
    <div className="button-row"><Button display="full" variant="weak" onClick={onEdit}>정보 수정</Button><Button display="full" onClick={onNewReading}>새 리딩</Button></div>
    <section><div className="section-heading"><h2>이전 리딩</h2><span>{person.readingCount}회 성공</span></div>{history.items.length === 0 ? <div className="state-card"><p>아직 리딩 기록이 없어요. 첫 질문을 시작해 보세요.</p></div> : <div className="list-stack"><div className="list">{history.items.map(item => <button className="list-row" key={item.id} onClick={() => onOpenReading(item.id)}><span><strong>{item.question}</strong><small>{item.summary || (item.status === 'FAILED' ? '생성 실패' : '결과 생성 중')}</small></span><span className={`status status--${item.status.toLowerCase()}`}>{formatDate(item.createdAt)}</span></button>)}</div>{moreError && <div className="error-message" role="alert">{moreError}</div>}{history.nextCursor && <Button display="full" variant="weak" loading={loadingMore} disabled={loadingMore} onClick={() => void loadMore()}>리딩 더 보기</Button>}</div>}</section>
  </div></>
}
