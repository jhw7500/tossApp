export type ReadingFormValidation =
  | { valid: true; code: null }
  | { valid: false; code: 'QUESTION_REQUIRED' | 'CUSTOM_REQUIRED' | 'CUSTOM_TOO_LONG' | 'CARD_REQUIRED' | 'DUPLICATE_CARD' }

type ReadingFormInput = {
  questionId: string
  isCustomTemplate: boolean
  customText: string
  positions: ReadonlyArray<{ position: number }>
  selections: Readonly<Record<number, string | undefined>>
}

export function validateReadingForm(input: ReadingFormInput): ReadingFormValidation {
  if (!input.questionId) return { valid: false, code: 'QUESTION_REQUIRED' }
  const customText = input.customText.trim()
  if (input.isCustomTemplate && !customText) return { valid: false, code: 'CUSTOM_REQUIRED' }
  if (input.isCustomTemplate && Array.from(customText).length > 500) return { valid: false, code: 'CUSTOM_TOO_LONG' }
  const selected = input.positions.map(({ position }) => input.selections[position]).filter((card): card is string => Boolean(card))
  if (selected.length !== input.positions.length) return { valid: false, code: 'CARD_REQUIRED' }
  if (new Set(selected).size !== selected.length) return { valid: false, code: 'DUPLICATE_CARD' }
  return { valid: true, code: null }
}

export function toggleCardSelection(selections: Readonly<Record<number, string>>, position: number, cardId: string): Record<number, string> {
  const next = { ...selections }
  if (next[position] === cardId) delete next[position]
  else next[position] = cardId
  return next
}
