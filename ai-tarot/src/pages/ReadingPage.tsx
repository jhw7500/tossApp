import { Button } from '@toss/tds-mobile'
import { useEffect, useState } from 'react'
import type { BrowserService } from '../api/service.ts'
import type { AcceptedReading, ReadingDetail } from '../api/types.ts'
import { errorMessage, formatDate, readingFailureMessage } from './page-utils.ts'
import { ErrorState, LoadingState, PageIntro } from './shared.tsx'

const isPending = (reading: ReadingDetail) => reading.status === 'QUEUED' || reading.status === 'RUNNING'
export function ReadingPage({ readingId, service, onRetryAccepted }: { readingId: string; service: BrowserService; onRetryAccepted: (accepted: AcceptedReading) => void }) {
  const [reading, setReading] = useState<ReadingDetail | null>(null); const [loading, setLoading] = useState(true); const [retrying, setRetrying] = useState(false); const [error, setError] = useState(''); const [pollGeneration, setPollGeneration] = useState(0); const [relationshipLabel, setRelationshipLabel] = useState('관계')
  useEffect(() => { let disposed = false; void service.listRelationships().then(catalog => { if (!disposed) setRelationshipLabel(catalog.items.find(item => item.code === reading?.input.relationshipCode)?.label ?? '관계') }).catch(() => undefined); return () => { disposed = true } }, [reading?.input.relationshipCode, service])
  useEffect(() => {
    let disposed = false; let timer: number | undefined
    const poll = async () => { try { const next = await service.getReading(readingId); if (disposed) return; setReading(next); setLoading(false); setError(''); if (isPending(next)) timer = window.setTimeout(() => void poll(), 2000) } catch (caught) { if (!disposed) { setLoading(false); setError(errorMessage(caught)) } } }
    void poll(); return () => { disposed = true; if (timer !== undefined) clearTimeout(timer) }
  }, [readingId, service, pollGeneration])
  const refreshStatus = () => { setError(''); setLoading(true); setPollGeneration(value => value + 1) }
  const retry = async () => { if (!reading) return; setRetrying(true); setError(''); try { const accepted = await service.retryReading(reading.id, reading.personId, { expectedAttemptNo: reading.attemptNo }); onRetryAccepted(accepted); setReading(null); setLoading(true); setRetrying(false); setPollGeneration(value => value + 1) } catch (caught) { setError(errorMessage(caught)); setRetrying(false) } }
  if (loading) return <><PageIntro title="리딩 결과" /><div className="content-stack"><LoadingState>리딩을 확인하고 있어요.</LoadingState></div></>
  if (error && !reading) return <><PageIntro title="리딩 결과" /><div className="content-stack"><ErrorState message={error} onRetry={() => location.reload()} /></div></>
  if (!reading) return null
  if (error && isPending(reading)) return <><PageIntro title="리딩 상태를 확인하지 못했어요" description="리딩 요청은 그대로 유지돼요. 연결을 확인한 뒤 상태를 다시 불러와 주세요." /><div className="content-stack"><ErrorState message={error} onRetry={refreshStatus} /></div></>
  if (isPending(reading)) return <><PageIntro eyebrow={`시도 ${reading.attemptNo}/3`} title="카드의 흐름을 읽고 있어요" description="완료되면 이 화면에 결과가 바로 나타나요." /><div className="content-stack"><LoadingState>{reading.status === 'QUEUED' ? '리딩 순서를 기다리고 있어요.' : '선택한 원문을 바탕으로 결과를 만들고 있어요.'}</LoadingState></div></>
  if (reading.status === 'FAILED') {
    const canRetry = Boolean(reading.error?.retryable) && reading.attemptNo < 3
    return <><PageIntro eyebrow={`시도 ${reading.attemptNo}/3`} title="리딩을 완성하지 못했어요" description="실패한 응답은 결과로 저장하지 않았어요." /><div className="content-stack"><section className="state-card state-card--error" role="alert"><h2>{readingFailureMessage(reading.error?.code)}</h2><p>{canRetry ? '같은 질문과 카드로 다시 요청할 수 있어요.' : '현재 기록은 다시 시도할 수 없어요. 새 리딩을 시작해 주세요.'}</p>{canRetry && <Button display="full" loading={retrying} disabled={retrying} onClick={() => void retry()}>같은 내용으로 다시 시도</Button>}</section>{error && <div className="error-message" role="alert">{error}</div>}</div></>
  }
  if (!reading.result) return <><PageIntro title="리딩 결과" /><div className="content-stack"><ErrorState message="완료된 결과를 불러오지 못했어요." onRetry={() => location.reload()} /></div></>
  return <><PageIntro eyebrow={formatDate(reading.createdAt)} title={reading.result.summary} description={reading.input.question.text} /><div className="content-stack result-stack">
    <div className="result-badges"><span>{reading.aiGenerated ? 'AI 생성 결과' : '검증용 생성 결과'}</span>{reading.testContent && <span>시험 콘텐츠</span>}</div>
    {[...reading.result.cards].sort((a, b) => a.positionIndex - b.positionIndex).map(result => { const input = reading.input.cards.find(card => card.positionIndex === result.positionIndex); return <article className="result-card" key={result.positionIndex}><p className="eyebrow">{result.positionIndex}. {input?.label}</p><h2>{input?.name}</h2><p>{result.text}</p></article> })}
    <article className="result-card result-card--overall"><p className="eyebrow">종합 리딩</p><p>{reading.result.overallReading}</p></article>
    <section className="snapshot-note"><h2>이 리딩에 저장된 정보</h2><p>{reading.input.personNickname} · {relationshipLabel}</p><p>{reading.input.currentSituation || '상황 메모 없음'}</p><small>이전 기록은 지금의 인연 정보가 바뀌어도 당시 내용 그대로 보여요.</small></section>
  </div></>
}
