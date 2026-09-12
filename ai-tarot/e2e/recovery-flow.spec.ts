import { expect, test, type Page, type Route } from '@playwright/test'
import type { FromSchema } from 'json-schema-to-ts'
import type { personPatchBodySchema, personSchema } from '../../contracts/foundation.schemas'
import type { acceptedReadingSchema, createReadingBodySchema, readingDetailSchema } from '../../contracts/reading.schemas'
import { appOrigin, installNetworkIsolation } from './network-isolation'

type AcceptedReading = FromSchema<typeof acceptedReadingSchema>
type CreateReadingBody = FromSchema<typeof createReadingBodySchema>
type PatchPersonBody = FromSchema<typeof personPatchBodySchema>
type Person = FromSchema<typeof personSchema>
type ReadingDetail = FromSchema<typeof readingDetailSchema>

const personId = '00000000-0000-4000-8000-000000000601'
const readingId = '00000000-0000-4000-8000-000000000602'
const questionId = '00000000-0000-4000-8000-000000000603'
const cardIds = [
  '00000000-0000-4000-8000-000000000611',
  '00000000-0000-4000-8000-000000000612',
  '00000000-0000-4000-8000-000000000613',
]
const cardNames = ['은둔자', '운명의 수레바퀴', '여사제']
const positionLabels = ['현재의 마음', '관계의 흐름', '다가올 변화']
const originalQuestion = '처음 보낸 질문을 어떻게 이어가면 좋을까요?'
const pendingKey = 'tarororo.pending-reading-request.v1'
const tossfaceStylesheet = 'https://cdn.jsdelivr.net/gh/toss/tossface/dist/tossface.css'
const personPath = `/api/v1/persons/${personId}`
const initialPerson: Person = {
  id: personId,
  nickname: '처음 별명',
  relationshipCode: 'dating',
  currentSituation: '처음 저장된 상황',
  version: 1,
  readingCount: 0,
  lastReadingAt: null,
  createdAt: '2026-09-12T03:00:00.000Z',
  updatedAt: '2026-09-12T03:00:00.000Z',
}
const latestPerson: Person = {
  ...initialPerson,
  nickname: '서버에서 바꾼 별명',
  relationshipCode: 'friend',
  currentSituation: '서버에서 바꾼 상황',
  version: 4,
  updatedAt: '2026-09-12T04:00:00.000Z',
}
const draft = { nickname: '내가 쓴 별명', relationshipCode: 'crush', currentSituation: '내가 쓴 상황' }

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

async function installApi(page: Page, handle: (route: Route, path: string, method: string) => Promise<boolean>) {
  const blockedRequests = await installNetworkIsolation(page)
  const unexpectedRequests: string[] = []
  const externalResponses: string[] = []
  const failedExternalRequests: string[] = []
  page.on('response', response => {
    if (new URL(response.url()).origin !== appOrigin) externalResponses.push(response.url())
  })
  page.on('requestfailed', request => {
    if (new URL(request.url()).origin !== appOrigin) failedExternalRequests.push(request.url())
  })
  await page.route(`${appOrigin}/api/v1/**`, async route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (await handle(route, path, method)) return
    if (path === '/api/v1/sessions/toss-anonymous' && method === 'POST') {
      return json(route, { token: 'recovery-test-token', expiresAt: '2099-01-01T00:00:00.000Z' }, 201)
    }
    if (path === '/api/v1/relationship-types' && method === 'GET') {
      return json(route, { items: [
        { code: 'dating', label: '연인' },
        { code: 'friend', label: '친구' },
        { code: 'crush', label: '짝사랑' },
      ] })
    }
    unexpectedRequests.push(`${method} ${route.request().url()}`)
    return route.abort('blockedbyclient')
  })
  return { blockedRequests, unexpectedRequests, externalResponses, failedExternalRequests }
}

function expectNetworkIsolated(audit: Awaited<ReturnType<typeof installApi>>) {
  expect(audit.unexpectedRequests).toEqual([])
  expect(audit.externalResponses).toEqual([])
  // src/index.css requests Tossface from a CDN; it must fail locally in this suite.
  expect(audit.blockedRequests.filter(url => url !== tossfaceStylesheet)).toEqual([])
  expect(audit.failedExternalRequests).toEqual(audit.blockedRequests)
}

async function expectFields(page: Page, fields: Pick<Person, 'nickname' | 'relationshipCode' | 'currentSituation'>, locked: boolean) {
  const controls = [
    { locator: page.getByRole('textbox', { name: '별명', exact: true }), value: fields.nickname },
    { locator: page.getByRole('combobox', { name: '관계', exact: true }), value: fields.relationshipCode },
    { locator: page.getByRole('textbox', { name: '현재 상황', exact: true }), value: fields.currentSituation ?? '' },
  ]
  for (const { locator, value } of controls) {
    await expect(locator).toHaveValue(value)
    await expect(locator).toBeEnabled({ enabled: !locked })
  }
  await expect(page.getByRole('button', { name: '최신 정보로 저장', exact: true })).toBeEnabled({ enabled: !locked })
}

for (const choice of ['최신 내용 사용', '내 입력으로 다시 저장'] as const) {
  test(`person PATCH 409 preserves and locks the draft until choosing ${choice}`, async ({ page }) => {
    let serverPerson = { ...initialPerson }
    const patches: PatchPersonBody[] = []
    const events: string[] = []
    const audit = await installApi(page, async (route, path, method) => {
      if (path === personPath && method === 'GET') {
        events.push(`GET:${serverPerson.version}`)
        await json(route, serverPerson)
        return true
      }
      if (path === personPath && method === 'PATCH') {
        const body = route.request().postDataJSON() as PatchPersonBody
        patches.push(body)
        events.push(`PATCH:${body.version}`)
        if (patches.length === 1) serverPerson = { ...latestPerson }
        if (body.version !== serverPerson.version) {
          await json(route, { error: { code: 'VERSION_CONFLICT', message: '다른 곳에서 수정됐어요.', retryable: false } }, 409)
        } else {
          serverPerson = { ...serverPerson, ...body, version: serverPerson.version + 1 }
          await json(route, serverPerson)
        }
        return true
      }
      if (path === `${personPath}/readings` && method === 'GET') {
        await json(route, { items: [], nextCursor: null })
        return true
      }
      return false
    })

    await page.goto(`/?person=${personId}&edit=1`)
    await expectFields(page, initialPerson, false)
    await page.getByRole('textbox', { name: '별명', exact: true }).fill(draft.nickname)
    await page.getByRole('combobox', { name: '관계', exact: true }).selectOption(draft.relationshipCode)
    await page.getByRole('textbox', { name: '현재 상황', exact: true }).fill(draft.currentSituation)
    const conflictResponse = page.waitForResponse(response => response.url() === `${appOrigin}${personPath}` && response.request().method() === 'PATCH')
    await page.getByRole('button', { name: '최신 정보로 저장', exact: true }).click()
    expect((await conflictResponse).status()).toBe(409)

    const conflict = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: '다른 곳에서 수정된 내용을 찾았어요' }) })
    await expect(conflict).toBeVisible()
    await expect(page.locator('.notice[role="status"]')).toContainText('작성 중인 내용은 그대로 두었어요.')
    await expectFields(page, draft, true)
    await expect(conflict.locator('dd')).toHaveText([latestPerson.nickname, '친구', latestPerson.currentSituation!])
    for (const name of ['최신 내용 사용', '내 입력으로 다시 저장']) {
      await expect(conflict.getByRole('button', { name, exact: true })).toBeVisible()
      await expect(conflict.getByRole('button', { name, exact: true })).toBeEnabled()
    }
    expect(patches).toEqual([{ ...draft, version: initialPerson.version }])
    expect(events.slice(events.indexOf('PATCH:1'))).toEqual(['PATCH:1', 'GET:4'])

    await conflict.getByRole('button', { name: choice, exact: true }).click()
    if (choice === '최신 내용 사용') {
      await expect(conflict).toHaveCount(0)
      await expect(page.locator('.notice[role="status"]')).toHaveText('최신 서버 내용을 입력란에 적용했어요.')
      await expectFields(page, latestPerson, false)
      await expect(page).toHaveURL(`${appOrigin}/?person=${personId}&edit=1`)
      expect(patches).toHaveLength(1)
      await page.getByRole('button', { name: '최신 정보로 저장', exact: true }).click()
    }

    const expectedFields = choice === '최신 내용 사용' ? {
      nickname: latestPerson.nickname,
      relationshipCode: latestPerson.relationshipCode,
      currentSituation: latestPerson.currentSituation,
    } : draft
    await expect(page).toHaveURL(`${appOrigin}/?person=${personId}`)
    await expect(page.getByRole('heading', { level: 1, name: expectedFields.nickname, exact: true })).toBeVisible()
    expect(patches).toEqual([{ ...draft, version: 1 }, { ...expectedFields, version: 4 }])
    expect(events.slice(events.indexOf('PATCH:1'), events.indexOf('PATCH:4') + 1)).toEqual(['PATCH:1', 'GET:4', 'PATCH:4'])
    // StrictMode can repeat reads when the detail screen mounts.
    expect(new Set(events.slice(events.indexOf('PATCH:4') + 1))).toEqual(new Set(['GET:5']))
    expectNetworkIsolated(audit)
  })
}

for (const failure of ['lost response', '503 response'] as const) {
  test(`manual recovery after ${failure} replays the saved envelope and opens the same Reading`, async ({ page }) => {
    const expectedBody: CreateReadingBody = {
      personId,
      personVersion: initialPerson.version,
      question: { id: questionId, version: 2, customText: originalQuestion },
      selections: cardIds.map((cardId, index) => ({ positionIndex: index + 1, cardId })),
    }
    const accepted: AcceptedReading = { readingId, status: 'QUEUED', attemptNo: 1, statusUrl: `/v1/readings/${readingId}` }
    const reading: ReadingDetail = {
      id: readingId, personId, status: 'SUCCEEDED', attemptNo: 1,
      createdAt: '2026-09-12T04:00:00.000Z', updatedAt: '2026-09-12T04:00:01.000Z',
      input: {
        personNickname: initialPerson.nickname, relationshipCode: initialPerson.relationshipCode,
        currentSituation: initialPerson.currentSituation,
        question: { id: questionId, version: 2, text: originalQuestion, isCustom: true },
        cards: cardIds.map((cardId, index) => ({ cardId, positionIndex: index + 1, name: cardNames[index], label: positionLabels[index] })),
      },
      result: {
        summary: '처음 접수한 리딩을 다시 찾았어요',
        overallReading: '같은 질문과 카드로 접수한 결과예요.',
        cards: cardIds.map((cardId, index) => ({
          cardId, positionIndex: index + 1, text: `${positionLabels[index]}에 대한 복구 테스트 결과예요.`,
          evidence: [{ interpretationId: `00000000-0000-4000-8000-00000000062${index + 1}`, version: 1 }],
        })),
      },
      error: null, aiGenerated: true, testContent: true,
    }
    const posts: Array<{ path: string; body: string | null; key: string | null; stored: string | null }> = []
    const readingsByKey = new Map<string, { body: string | null; accepted: AcceptedReading }>()
    const readingGets: string[] = []
    let releaseReplay!: () => void
    const replayGate = new Promise<void>(resolve => { releaseReplay = resolve })
    const audit = await installApi(page, async (route, path, method) => {
      if (path === personPath && method === 'GET') {
        await json(route, initialPerson)
        return true
      }
      if (path === '/api/v1/questions' && method === 'GET') {
        await json(route, { items: [{
          id: questionId, version: 2, relationshipCode: 'dating', prompt: '직접 질문하기', isCustomTemplate: true,
          positions: positionLabels.map((label, index) => ({ position: index + 1, label })),
        }] })
        return true
      }
      if (path === '/api/v1/cards' && method === 'GET') {
        await json(route, { items: cardIds.map((id, index) => ({ id, code: `RECOVERY_${index + 1}`, name: cardNames[index], arcana: 'MAJOR', imageUrl: null })) })
        return true
      }
      if (path === '/api/v1/readings' && method === 'POST') {
        const request = route.request()
        const key = request.headers()['idempotency-key'] ?? null
        const body = request.postData()
        const stored = await page.evaluate(key => sessionStorage.getItem(key), pendingKey)
        posts.push({ path, body, key, stored })
        if (!key) {
          await json(route, { error: { code: 'INVALID_INPUT', message: 'idempotency key required', retryable: false } }, 400)
          return true
        }
        const existing = readingsByKey.get(key)
        if (!existing) readingsByKey.set(key, { body, accepted })
        if (posts.length === 1) {
          // The server has accepted it; the client cannot tell whether it has.
          if (failure === 'lost response') await route.abort('connectionfailed')
          else await json(route, { error: { code: 'INTERNAL_ERROR', message: 'acceptance unknown', retryable: true } }, 503)
        } else {
          await replayGate
          if (!existing || existing.body !== body) {
            await json(route, { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'saved envelope required', retryable: false } }, 409)
          } else await json(route, existing.accepted, 200)
        }
        return true
      }
      if (path === `/api/v1/readings/${readingId}` && method === 'GET') {
        readingGets.push(path)
        await json(route, reading)
        return true
      }
      return false
    })

    try {
      await page.goto(`/?person=${personId}&reading=new`)
      await page.getByRole('textbox', { name: '직접 질문' }).fill(originalQuestion)
      for (let index = 0; index < cardIds.length; index += 1) {
        await page.getByRole('group', { name: `${index + 1}. ${positionLabels[index]}`, exact: true })
          .getByRole('button', { name: `${cardNames[index]}, 카드 선택`, exact: true }).click()
      }
      await page.getByRole('button', { name: '리딩 만들기', exact: true }).click()
      const recovery = page.getByRole('status').filter({ has: page.getByRole('heading', { name: '먼저 보낸 리딩을 확인해 주세요' }) })
      await expect(recovery).toBeVisible()
      await expect(page.getByRole('alert')).toHaveText(failure === 'lost response'
        ? '서버에 연결하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.' : '서버에서 요청을 처리하지 못했어요.')
      expect(posts).toHaveLength(1)
      expect(posts[0].key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(JSON.parse(posts[0].body!)).toEqual(expectedBody)
      const savedEnvelope = posts[0].stored
      expect(savedEnvelope).not.toBeNull()
      expect(JSON.parse(savedEnvelope!)).toEqual({
        version: 1, path: '/v1/readings', body: expectedBody, idempotencyKey: posts[0].key, personId,
      })
      expect(await page.evaluate(key => sessionStorage.getItem(key), pendingKey)).toBe(savedEnvelope)

      // A changed form must not overwrite or create alongside the uncertain request.
      await page.getByRole('textbox', { name: '직접 질문' }).fill('나중에 새로 작성한 질문')
      await page.getByRole('button', { name: '리딩 만들기', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveText('접수 여부를 확인 중인 리딩이 있어요. 입력을 바꾸기 전에 같은 내용으로 다시 확인해 주세요.')
      expect(posts).toHaveLength(1)
      expect(readingGets).toEqual([])
      expect(await page.evaluate(key => sessionStorage.getItem(key), pendingKey)).toBe(savedEnvelope)
      await expect(page).toHaveURL(`${appOrigin}/?person=${personId}&reading=new`)

      const recover = recovery.getByRole('button', { name: /^접수 중인 리딩 확인/ })
      await recover.click()
      await expect.poll(() => posts.length).toBe(2)
      await expect(recover).toBeDisabled()
      // Dispatching a second click while pending must not send a duplicate replay.
      await recover.dispatchEvent('click')
      expect(posts[1]).toEqual(posts[0])
      releaseReplay()

      await expect(page).toHaveURL(`${appOrigin}/?person=${personId}&reading=${readingId}`)
      await expect(page.getByRole('heading', { level: 1, name: reading.result!.summary, exact: true })).toBeVisible()
      await expect(page.getByText(originalQuestion, { exact: true })).toBeVisible()
      await expect(page.getByText('나중에 새로 작성한 질문', { exact: true })).toHaveCount(0)
      await expect(recovery).toHaveCount(0)
      expect(posts).toHaveLength(2)
      expect(readingsByKey.size).toBe(1)
      expect(new Set(readingGets)).toEqual(new Set([`/api/v1/readings/${readingId}`]))
      expect(await page.evaluate(key => sessionStorage.getItem(key), pendingKey)).toBeNull()
      expectNetworkIsolated(audit)
    } finally {
      releaseReplay()
    }
  })
}
