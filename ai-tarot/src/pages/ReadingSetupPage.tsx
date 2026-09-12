import { Button, TextArea } from '@toss/tds-mobile'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { BrowserService, RecoveredReading } from '../api/service.ts'
import type { AcceptedReading, Person, Question, TarotCard } from '../api/types.ts'
import { toggleCardSelection, validateReadingForm } from '../features/reading-form.ts'
import { errorMessage } from './page-utils.ts'
import { ErrorState, LoadingState, PageIntro } from './shared.tsx'

const validationMessage = { QUESTION_REQUIRED: '질문을 선택해 주세요.', CUSTOM_REQUIRED: '직접 질문을 입력해 주세요.', CUSTOM_TOO_LONG: '직접 질문은 500자까지 입력할 수 있어요.', CARD_REQUIRED: '각 위치에 카드를 한 장씩 선택해 주세요.', DUPLICATE_CARD: '같은 카드는 한 번만 선택할 수 있어요.' } as const

export function ReadingSetupPage({ personId, service, onAccepted, onRecovered }: { personId: string; service: BrowserService; onAccepted: (accepted: AcceptedReading) => void; onRecovered: (recovered: RecoveredReading) => void }) {
  const [person, setPerson] = useState<Person | null>(null); const [questions, setQuestions] = useState<Question[]>([]); const [cards, setCards] = useState<TarotCard[]>([])
  const [questionId, setQuestionId] = useState(''); const [customText, setCustomText] = useState(''); const [selections, setSelections] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(true); const [submitting, setSubmitting] = useState(false); const [recovering, setRecovering] = useState(false); const [pendingAvailable, setPendingAvailable] = useState(false); const [error, setError] = useState('')
  const selectedQuestion = useMemo(() => questions.find(question => question.id === questionId) ?? null, [questions, questionId])
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const nextPerson = await service.getPerson(personId); const [nextQuestions, nextCards] = await Promise.all([service.listQuestions(nextPerson.relationshipCode), service.listCards()]); setPerson(nextPerson); setQuestions(nextQuestions.items); setCards(nextCards.items); setQuestionId(value => value || nextQuestions.items[0]?.id || '') }
    catch (caught) { setError(errorMessage(caught)) } finally { setLoading(false) }
  }, [personId, service])
  useEffect(() => { void load() }, [load])
  const submit = async () => {
    if (!person || !selectedQuestion) return
    const validation = validateReadingForm({ questionId, isCustomTemplate: selectedQuestion.isCustomTemplate, customText, positions: selectedQuestion.positions, selections })
    if (!validation.valid) { setError(validationMessage[validation.code]); return }
    setSubmitting(true); setError('')
    try {
      const question = { id: selectedQuestion.id, version: selectedQuestion.version, ...(selectedQuestion.isCustomTemplate ? { customText: customText.trim() } : {}) }
      const accepted = await service.createReading({ personId: person.id, personVersion: person.version, question, selections: selectedQuestion.positions.map(position => ({ positionIndex: position.position, cardId: selections[position.position]! })) })
      onAccepted(accepted)
    } catch (caught) { setError(errorMessage(caught)); setPendingAvailable(service.hasPendingReading()) } finally { setSubmitting(false) }
  }
  const recoverPending = async () => {
    setRecovering(true); setError('')
    try { const recovered = await service.resumePendingReading(); setPendingAvailable(false); if (recovered) onRecovered(recovered); else setError('확인할 리딩 요청이 없어요.') }
    catch (caught) { setError(errorMessage(caught)); setPendingAvailable(service.hasPendingReading()) }
    finally { setRecovering(false) }
  }
  if (loading) return <><PageIntro title="새 리딩" /><div className="content-stack"><LoadingState /></div></>
  if (!person || questions.length === 0 || cards.length === 0) return <><PageIntro title="새 리딩" /><div className="content-stack"><ErrorState message={error || '리딩에 필요한 질문이나 카드를 불러오지 못했어요.'} onRetry={() => void load()} /></div></>
  const handleSubmit = (event: FormEvent) => { event.preventDefault(); void submit() }
  return <><PageIntro eyebrow={person.nickname} title="무엇을 물어볼까요?" description="질문과 각 위치에 놓을 서로 다른 카드 세 장을 골라 주세요." /><form className="content-stack" onSubmit={handleSubmit}>
    {error && <div className="error-message" id="reading-form-error" role="alert">{error}</div>}
    {pendingAvailable && <section className="state-card recovery-action" role="status"><h2>먼저 보낸 리딩을 확인해 주세요</h2><p>작성 중인 내용과 별개로, 접수 결과가 불확실한 이전 요청이 남아 있어요.</p><Button type="button" display="full" variant="weak" loading={recovering} disabled={recovering} onClick={() => void recoverPending()}>접수 중인 리딩 확인</Button></section>}
    <fieldset className="choice-group"><legend>질문</legend>{questions.map(question => <label className={`choice-card ${question.id === questionId ? 'choice-card--selected' : ''}`} key={`${question.id}-${question.version}`}><input type="radio" name="question" value={question.id} checked={question.id === questionId} onChange={() => { setQuestionId(question.id); setSelections({}); setError('') }} /><span>{question.prompt}</span></label>)}</fieldset>
    {selectedQuestion?.isCustomTemplate && <label className="field"><span>직접 질문</span><TextArea variant="box" minHeight={100} value={customText} maxLength={500} placeholder="궁금한 내용을 500자 안으로 적어 주세요." aria-label="직접 질문" aria-describedby="custom-question-count" onChange={event => setCustomText(event.target.value)} /><small id="custom-question-count">{Array.from(customText).length}/500</small></label>}
    {selectedQuestion?.positions.map(position => { const descriptionId = `card-position-${position.position}-description`; return <fieldset className="choice-group" aria-describedby={position.description ? descriptionId : undefined} key={position.position}><legend>{position.position}. {position.label}</legend>{position.description && <p className="field-description" id={descriptionId}>{position.description}</p>}<div className="card-grid">{cards.map(card => { const selectedHere = selections[position.position] === card.id; const selectedElsewhere = Object.entries(selections).some(([index, id]) => Number(index) !== position.position && id === card.id); const selectionLabel = selectedHere ? '선택됨' : selectedElsewhere ? '다른 위치에서 선택됨' : '카드 선택'; return <button type="button" className={`tarot-card ${selectedHere ? 'tarot-card--selected' : ''}`} aria-label={`${card.name}, ${selectionLabel}`} aria-pressed={selectedHere} disabled={selectedElsewhere} key={card.id} onClick={() => { setSelections(value => toggleCardSelection(value, position.position, card.id)); setError('') }}><strong>{card.name}</strong><small>{selectedHere ? '다시 눌러 해제' : selectedElsewhere ? '다른 위치에서 선택됨' : '카드 선택'}</small></button> })}</div></fieldset> })}
    <div className="page-actions"><Button type="submit" display="full" loading={submitting} disabled={submitting}>리딩 만들기</Button></div>
  </form></>
}
