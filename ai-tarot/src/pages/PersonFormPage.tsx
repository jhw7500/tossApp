import { Button, TextArea, TextField } from '@toss/tds-mobile'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/client.ts'
import type { BrowserService } from '../api/service.ts'
import type { Person, RelationshipType } from '../api/types.ts'
import { resolvePersonConflict, type PersonConflict, type PersonDraft } from '../features/person-conflict.ts'
import { errorMessage } from './page-utils.ts'
import { ErrorState, LoadingState, PageIntro } from './shared.tsx'

export function PersonFormPage({ service, personId, onSaved }: { service: BrowserService; personId?: string; onSaved: (person: Person) => void }) {
  const [relationships, setRelationships] = useState<RelationshipType[]>([])
  const [nickname, setNickname] = useState('')
  const [relationshipCode, setRelationshipCode] = useState('')
  const [currentSituation, setCurrentSituation] = useState('')
  const [version, setVersion] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState<PersonConflict | null>(null)
  const applyFields = useCallback((fields: PersonDraft) => { setNickname(fields.nickname); setRelationshipCode(fields.relationshipCode); setCurrentSituation(fields.currentSituation ?? '') }, [])
  const applyPerson = useCallback((person: Person) => { applyFields(person); setVersion(person.version) }, [applyFields])
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [catalog, person] = await Promise.all([service.listRelationships(), personId ? service.getPerson(personId) : Promise.resolve(null)])
      setRelationships(catalog.items)
      if (person) applyPerson(person); else setRelationshipCode(value => value || catalog.items[0]?.code || '')
    } catch (caught) { setError(errorMessage(caught)) }
    finally { setLoading(false) }
  }, [applyPerson, personId, service])
  useEffect(() => { void load() }, [load])
  const captureDraft = (): PersonDraft => ({ nickname: nickname.trim(), relationshipCode, currentSituation: currentSituation.trim() || null })
  const captureConflict = async (draft: PersonDraft) => {
    if (!personId) return
    try {
      const latest = await service.getPerson(personId)
      setConflict({ draft, latest })
      setNotice('작성 중인 내용은 그대로 두었어요. 최신 내용을 비교한 뒤 저장할 내용을 선택해 주세요.')
    } catch (reloadError) { setError(errorMessage(reloadError)) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedNickname = nickname.trim()
    if (!trimmedNickname || !relationshipCode) { setError('별명과 관계를 모두 입력해 주세요.'); return }
    setSaving(true); setError(''); setNotice('')
    try {
      const body: PersonDraft = { nickname: trimmedNickname, relationshipCode, currentSituation: currentSituation.trim() || null }
      const saved = personId && version ? await service.updatePerson(personId, { ...body, version }) : await service.createPerson(body)
      onSaved(saved)
    } catch (caught) {
      if (personId && caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        await captureConflict(captureDraft())
      } else setError(errorMessage(caught))
    } finally { setSaving(false) }
  }
  const useLatest = () => {
    if (!conflict) return
    const resolution = resolvePersonConflict(conflict, 'use-latest')
    applyFields(resolution.fields); setVersion(conflict.latest.version); setConflict(null); setNotice('최신 서버 내용을 입력란에 적용했어요.')
  }
  const keepDraft = async () => {
    if (!conflict || !personId) return
    const resolution = resolvePersonConflict(conflict, 'keep-draft')
    setSaving(true); setError(''); setNotice('')
    try { onSaved(await service.updatePerson(personId, resolution.patch!)) }
    catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') await captureConflict(conflict.draft)
      else setError(errorMessage(caught))
    } finally { setSaving(false) }
  }
  if (loading) return <><PageIntro title={personId ? '인연 정보 수정' : '새 인연 등록'} /><div className="content-stack"><LoadingState /></div></>
  if (error && relationships.length === 0) return <><PageIntro title={personId ? '인연 정보 수정' : '새 인연 등록'} /><div className="content-stack"><ErrorState message={error} onRetry={() => void load()} /></div></>
  return <><PageIntro title={personId ? '인연 정보 수정' : '새 인연 등록'} description="리딩에 필요한 현재 정보만 적어 주세요. 언제든 다시 바꿀 수 있어요." /><form className="content-stack form-stack" onSubmit={event => void submit(event)}>
    {notice && <div className="notice" role="status">{notice}</div>}{error && <div className="error-message" role="alert">{error}</div>}
    {conflict && <section className="state-card conflict-card" role="alert"><h2>다른 곳에서 수정된 내용을 찾았어요</h2><p>최신 서버 값</p><dl><div><dt>별명</dt><dd>{conflict.latest.nickname}</dd></div><div><dt>관계</dt><dd>{relationships.find(item => item.code === conflict.latest.relationshipCode)?.label ?? '관계 정보'}</dd></div><div><dt>현재 상황</dt><dd>{conflict.latest.currentSituation || '상황 메모 없음'}</dd></div></dl><div className="button-row"><Button type="button" display="full" variant="weak" disabled={saving} onClick={useLatest}>최신 내용 사용</Button><Button type="button" display="full" loading={saving} disabled={saving} onClick={() => void keepDraft()}>내 입력으로 다시 저장</Button></div></section>}
    <label className="field"><span>별명</span><TextField variant="box" value={nickname} maxLength={30} placeholder="예: 민지" aria-label="별명" disabled={Boolean(conflict)} onChange={event => setNickname(event.target.value)} /></label>
    <label className="field"><span>관계</span><select value={relationshipCode} aria-label="관계" disabled={Boolean(conflict)} onChange={event => setRelationshipCode(event.target.value)} required>{relationships.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
    <label className="field"><span>현재 상황</span><TextArea variant="box" value={currentSituation} maxLength={2000} minHeight={120} placeholder="최근 연락이나 관계 상황을 적어 주세요." aria-label="현재 상황" aria-describedby="person-situation-count" disabled={Boolean(conflict)} onChange={event => setCurrentSituation(event.target.value)} /><small id="person-situation-count">{Array.from(currentSituation).length}/2000</small></label>
    <div className="page-actions"><Button type="submit" display="full" loading={saving} disabled={saving || Boolean(conflict) || !nickname.trim() || !relationshipCode}>{personId ? '최신 정보로 저장' : '인연 등록'}</Button></div>
  </form></>
}
