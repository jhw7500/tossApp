import { ApiError } from '../api/client.ts'

export const formatDate = (value: string | null): string => value ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(new Date(value)) : '아직 없음'

const apiMessages: Record<string, string> = {
  UNAUTHORIZED: '사용자 확인이 만료됐어요. 다시 시도해 주세요.',
  AUTH_UNAVAILABLE: '사용자 확인 서비스를 잠시 이용할 수 없어요.',
  RATE_LIMITED: '요청이 많아요. 잠시 뒤 다시 시도해 주세요.',
  AI_RATE_LIMITED: '리딩 요청이 많아요. 잠시 뒤 다시 시도해 주세요.',
  AI_TIMEOUT: '리딩 생성 시간이 길어져 중단됐어요.',
  INTERNAL_ERROR: '서버에서 요청을 처리하지 못했어요.',
}

export const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) return apiMessages[error.code] ?? '요청을 처리하지 못했어요.'
  if (error instanceof Error && /[가-힣]/.test(error.message)) return error.message
  return '서버에 연결하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.'
}

export const readingFailureMessage = (code?: string): string => code ? (apiMessages[code] ?? '리딩 생성 중 오류가 발생했어요.') : '리딩 생성 중 오류가 발생했어요.'
