import { expect, test, type Page, type Route } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const personId = '00000000-0000-4000-8000-000000000101'
const readingId = '00000000-0000-4000-8000-000000000201'
const questionId = '00000000-0000-4000-8000-000000000301'
const cardIds = [
  '00000000-0000-4000-8000-000000000401',
  '00000000-0000-4000-8000-000000000402',
  '00000000-0000-4000-8000-000000000403',
]
const longNickname = '오래 기억하고 싶은 인연의 매우 긴 별명'
const longSituation = '서로의 속도를 존중하며 관계를 천천히 살피고 있어요. '.repeat(18)
const longQuestion = '지금 이 관계에서 서로의 마음과 앞으로의 흐름을 어떻게 이해하면 좋을까요?'
const resultSummary = '천천히 이어지는 대화가 관계의 방향을 보여줘요'
const longToken = 'https://example.test/' + 'unbroken-segment-'.repeat(24)
const resultParagraphs = `첫 번째 원문 문단은 현재의 망설임을 충분히 설명해요. ${longToken}\n\n두 번째 원문 문단은 서두르지 않고 대화의 흐름을 살피라고 안내해요.`

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

async function installApi(page: Page, seeded = false) {
  let personCreated = seeded
  let readingCreated = seeded
  const submitted: { person: Record<string, unknown> | null; reading: Record<string, unknown> | null } = { person: null, reading: null }
  const person = {
    id: personId,
    nickname: longNickname,
    relationshipCode: 'dating',
    currentSituation: longSituation,
    version: 1,
    readingCount: 1,
    lastReadingAt: '2026-09-12T04:00:00.000Z',
    createdAt: '2026-09-12T03:00:00.000Z',
    updatedAt: '2026-09-12T04:00:00.000Z',
  }
  const reading = {
    id: readingId,
    personId,
    status: 'SUCCEEDED',
    attemptNo: 1,
    createdAt: '2026-09-12T04:00:00.000Z',
    updatedAt: '2026-09-12T04:00:01.000Z',
    input: {
      personNickname: longNickname,
      relationshipCode: 'dating',
      currentSituation: longSituation,
      question: { id: questionId, version: 1, text: longQuestion, isCustom: true },
      cards: cardIds.map((cardId, index) => ({ cardId, name: ['은둔자', '운명의 수레바퀴', '여사제'][index], positionIndex: index + 1, label: ['현재의 마음', '관계의 흐름', '다가올 변화'][index] })),
    },
    result: {
      summary: resultSummary,
      overallReading: resultParagraphs,
      cards: cardIds.map((cardId, index) => ({ positionIndex: index + 1, cardId, text: resultParagraphs, evidence: [{ interpretationId: `00000000-0000-4000-8000-00000000050${index + 1}`, version: 1 }] })),
    },
    error: null,
    aiGenerated: true,
    testContent: true,
  }

  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    if (path === '/v1/sessions/toss-anonymous') return json(route, { token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' }, 201)
    if (path === '/v1/relationship-types') return json(route, { items: [{ code: 'dating', label: '연인' }] })
    if (path === '/v1/persons' && method === 'GET') return json(route, { items: personCreated ? [person] : [], nextCursor: null })
    if (path === '/v1/persons' && method === 'POST') {
      submitted.person = request.postDataJSON() as Record<string, unknown>
      Object.assign(person, submitted.person)
      personCreated = true
      return json(route, person, 201)
    }
    if (path === `/v1/persons/${personId}`) return json(route, person)
    if (path === `/v1/persons/${personId}/readings`) return json(route, {
      items: readingCreated ? [{ id: readingId, status: 'SUCCEEDED', question: reading.input.question.text, summary: reading.result.summary, createdAt: reading.createdAt }] : [],
      nextCursor: null,
    })
    if (path.startsWith('/v1/questions')) return json(route, { items: [{
      id: questionId,
      version: 1,
      relationshipCode: 'dating',
      prompt: '직접 질문하기',
      isCustomTemplate: true,
      positions: [
        { position: 1, label: '현재의 마음', description: '지금 드러나는 마음의 상태를 살펴봐요.' },
        { position: 2, label: '관계의 흐름', description: '두 사람 사이에서 움직이는 흐름을 살펴봐요.' },
        { position: 3, label: '다가올 변화', description: '앞으로 나타날 가능성을 살펴봐요.' },
      ],
    }] })
    if (path === '/v1/cards') return json(route, { items: cardIds.map((id, index) => ({ id, code: `CARD_${index + 1}`, name: ['은둔자', '운명의 수레바퀴', '여사제'][index], arcana: 'MAJOR', imageUrl: null })) })
    if (path === '/v1/readings' && method === 'POST') {
      submitted.reading = request.postDataJSON() as Record<string, unknown>
      const submittedQuestion = submitted.reading.question as { id: string; version: number; customText?: string }
      const submittedSelections = submitted.reading.selections as Array<{ positionIndex: number; cardId: string }>
      reading.input.personNickname = person.nickname
      reading.input.relationshipCode = person.relationshipCode
      reading.input.currentSituation = person.currentSituation
      reading.input.question = { id: submittedQuestion.id, version: submittedQuestion.version, text: submittedQuestion.customText ?? longQuestion, isCustom: Boolean(submittedQuestion.customText) }
      reading.input.cards = submittedSelections.map(selection => ({
        ...selection,
        name: ['은둔자', '운명의 수레바퀴', '여사제'][cardIds.indexOf(selection.cardId)],
        label: ['현재의 마음', '관계의 흐름', '다가올 변화'][selection.positionIndex - 1],
      }))
      readingCreated = true
      return json(route, { readingId, status: 'QUEUED', attemptNo: 1, statusUrl: `/v1/readings/${readingId}` }, 202)
    }
    if (path === `/v1/readings/${readingId}`) return json(route, reading)
    return json(route, { error: { code: 'NOT_FOUND', message: `${method} ${path}`, retryable: false } }, 404)
  })

  return submitted
}

async function setVisualViewport(page: Page, height: number, offsetTop = 0, eventType: 'resize' | 'scroll' = 'resize') {
  await page.evaluate(({ nextHeight, nextOffsetTop, nextEventType }) => {
    if (!window.visualViewport) throw new Error('visualViewport is required for this test')
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: nextHeight },
      offsetTop: { configurable: true, value: nextOffsetTop },
    })
    window.visualViewport.dispatchEvent(new Event(nextEventType))
  }, { nextHeight: height, nextOffsetTop: offsetTop, nextEventType: eventType })
}

async function expectHeadingAtTop(page: Page, name: string) {
  const heading = page.getByRole('heading', { level: 1, name })
  await expect(heading).toBeFocused()
  await expect(heading).toBeInViewport()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }))).toEqual({ width: 320, scrollWidth: 320 })
}

async function expectAccessibleSurface(page: Page) {
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
  for (const target of await page.locator('main button:not([disabled]):visible, main .choice-card:visible, main select:visible').all()) {
    const box = await target.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  expect(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('main *')).filter(element => {
    const style = getComputedStyle(element)
    const hasDirectText = Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
    return hasDirectText && style.display !== 'none' && style.visibility !== 'hidden' && Number.parseFloat(style.fontSize) <= 11
  }).map(element => element.textContent?.trim()))).toEqual([])
}

test('320px keyboard flow keeps actions visible and preserves accessible long-form reading output', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 700 })
  const submitted = await installApi(page)
  await page.goto('/')

  await page.getByRole('button', { name: '새 인연 등록' }).click()
  const personFormHeading = page.getByRole('heading', { level: 1, name: '새 인연 등록' })
  await expect(personFormHeading).toBeFocused()
  await expect(personFormHeading).toHaveCSS('outline-style', 'none')
  await expect(personFormHeading).toHaveCSS('box-shadow', 'none')
  await expect(page).toHaveTitle('새 인연 등록 | tarororo')

  await page.getByRole('textbox', { name: '별명' }).fill(longNickname)
  const situation = page.getByRole('textbox', { name: '현재 상황' })
  await expect(situation).toHaveAttribute('aria-describedby', 'person-situation-count')
  await situation.fill(longSituation)
  await situation.focus()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await setVisualViewport(page, 430, 20)
  const submit = page.getByRole('button', { name: '인연 등록' })
  await expect(submit.locator('..')).toHaveCSS('position', 'fixed')
  const situationField = situation.locator('xpath=ancestor::label[contains(@class,"field")]')
  await expect.poll(async () => {
    const [fieldBox, actionBox] = await Promise.all([situationField.boundingBox(), submit.boundingBox()])
    return fieldBox && actionBox ? actionBox.y - (fieldBox.y + fieldBox.height) : -1
  }).toBeGreaterThanOrEqual(0)
  const [situationBox, situationFieldBox, submitBox] = await Promise.all([situation.boundingBox(), situationField.boundingBox(), submit.boundingBox()])
  expect(situationBox).not.toBeNull()
  expect(situationFieldBox).not.toBeNull()
  expect(submitBox).not.toBeNull()
  expect(situationBox!.y + situationBox!.height).toBeLessThanOrEqual(submitBox!.y)
  expect(situationFieldBox!.y + situationFieldBox!.height).toBeLessThanOrEqual(submitBox!.y)
  expect(20 + 430 - (submitBox!.y + submitBox!.height)).toBeGreaterThanOrEqual(34)
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-area-bottom', '48px')
    window.dispatchEvent(new Event('tarororo:safe-area-change'))
  })
  await expect.poll(async () => { const box = await submit.boundingBox(); return box ? 20 + 430 - (box.y + box.height) : 0 }).toBeGreaterThanOrEqual(48)
  await setVisualViewport(page, 430, 0, 'scroll')
  await expect.poll(async () => { const box = await submit.boundingBox(); return box ? 430 - (box.y + box.height) : 0 }).toBeGreaterThanOrEqual(48)
  await expect.poll(async () => {
    const [fieldBox, actionBox] = await Promise.all([situationField.boundingBox(), submit.boundingBox()])
    return fieldBox && actionBox ? actionBox.y - (fieldBox.y + fieldBox.height) : -1
  }).toBeGreaterThanOrEqual(0)
  if (process.env.CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('person-form-keyboard-320.png') })
  await setVisualViewport(page, 700)
  await submit.click()

  await expect.poll(() => submitted.person).toEqual({ nickname: longNickname, relationshipCode: 'dating', currentSituation: longSituation.trim() })
  await expectHeadingAtTop(page, longNickname)
  await page.getByRole('button', { name: '새 리딩' }).click()
  await expectHeadingAtTop(page, '무엇을 물어볼까요?')
  await expect(page.locator('form')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '리딩 만들기' }).locator('..')).toHaveCSS('position', 'static')
  if (process.env.CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('reading-setup-320.png'), fullPage: true })

  const customQuestion = page.getByRole('textbox', { name: '직접 질문' })
  await expect(customQuestion).toHaveAttribute('aria-describedby', 'custom-question-count')
  await expect(page.locator('#custom-question-count')).toHaveText('0/500')
  await customQuestion.fill(longQuestion)
  const secondPosition = page.getByRole('group', { name: /^2\./ })
  await expect(secondPosition).toHaveAttribute('aria-describedby', 'card-position-2-description')
  for (let position = 1; position <= 3; position += 1) {
    const group = page.getByRole('group', { name: new RegExp(`^${position}\\.`) })
    await group.getByRole('button', { name: new RegExp(['은둔자', '운명의 수레바퀴', '여사제'][position - 1]) }).click()
    if (position === 1) await expect(secondPosition.getByRole('button', { name: /은둔자.*다른 위치에서 선택됨/ })).toBeDisabled()
  }
  await expectAccessibleSurface(page)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.getByRole('button', { name: '리딩 만들기' }).click()

  await expect.poll(() => submitted.reading).toEqual({
    personId,
    personVersion: 1,
    question: { id: questionId, version: 1, customText: longQuestion },
    selections: cardIds.map((cardId, index) => ({ positionIndex: index + 1, cardId })),
  })
  await expectHeadingAtTop(page, resultSummary)
  await expectNoHorizontalOverflow(page)
  const overallReading = page.locator('.result-card--overall p').last()
  await expect(overallReading).toHaveCSS('white-space', 'pre-wrap')
  await expect(overallReading).toHaveText(resultParagraphs)
  expect(await overallReading.evaluate(element => (element as HTMLElement).innerText)).toContain('\n\n')
  if (process.env.CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('reading-result-320.png'), fullPage: true })

  await page.goBack()
  await expectHeadingAtTop(page, longNickname)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.getByRole('button', { name: new RegExp(longQuestion) }).click()
  await expectHeadingAtTop(page, resultSummary)
  await expectNoHorizontalOverflow(page)

  await expectAccessibleSurface(page)
})

for (const width of [390, 480]) {
  test(`${width}px long content fits every reading-flow screen`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 })
    await installApi(page, true)
    const screens = [
      { name: 'persons', url: '/', heading: longNickname },
      { name: 'person', url: `/?person=${personId}`, heading: longNickname },
      { name: 'setup', url: `/?person=${personId}&reading=new`, heading: '무엇을 물어볼까요?' },
      { name: 'result', url: `/?person=${personId}&reading=${readingId}`, heading: resultSummary },
    ]
    for (const screen of screens) {
      await page.goto(screen.url)
      await expect(page.getByText(screen.heading, { exact: true }).first()).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      await expect(page.locator('.page-title')).toBeFocused()
      await expectAccessibleSurface(page)
      if (width === 390 && screen.name === 'persons') {
        await expect(page.locator('.list-row').first()).toHaveCSS('flex-direction', 'column')
        await expect(page.locator('.list-meta').first()).toHaveCSS('text-align', 'left')
        await page.locator('.page-title').focus()
        await page.keyboard.press('Tab')
        await expect(page.getByRole('button', { name: '새 인연 등록' })).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(page.locator('.list-row').first()).toBeFocused()
      }
      if (process.env.CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath(`${screen.name}-${width}.png`), fullPage: true })
    }
  })
}
