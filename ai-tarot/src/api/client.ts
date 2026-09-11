export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type ApiErrorBody = {
  code: string
  message: string
  retryable: boolean
  requestId?: string
}

export type ApiErrorOrigin = 'endpoint' | 'authentication'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly requestId?: string
  readonly origin: ApiErrorOrigin

  constructor(status: number, body: ApiErrorBody, origin: ApiErrorOrigin = 'endpoint') {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.retryable = body.retryable
    this.requestId = body.requestId
    this.origin = origin
  }
}

export type ApiRequestOptions = {
  idempotencyKey?: string
}

export type ApiTransport = {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown, options?: ApiRequestOptions): Promise<T>
  patch<T>(path: string, body: unknown): Promise<T>
}

type ClientDependencies = {
  baseUrl: string
  getAnonymousKey: () => Promise<string>
  fetch?: FetchLike
}

const parseError = async (response: Response, origin: ApiErrorOrigin = 'endpoint'): Promise<ApiError> => {
  try {
    const payload = await response.json() as { error?: Partial<ApiErrorBody> }
    return new ApiError(response.status, {
      code: payload.error?.code ?? 'HTTP_ERROR',
      message: payload.error?.message ?? '요청을 처리하지 못했어요.',
      retryable: payload.error?.retryable ?? false,
      requestId: payload.error?.requestId,
    }, origin)
  } catch {
    return new ApiError(response.status, {
      code: 'HTTP_ERROR',
      message: '요청을 처리하지 못했어요.',
      retryable: false,
    }, origin)
  }
}

export function createApiClient({ baseUrl, getAnonymousKey, fetch: fetchImpl = fetch }: ClientDependencies): ApiTransport {
  let token: string | null = null
  let identification: Promise<string> | null = null

  const identify = (): Promise<string> => {
    if (token) return Promise.resolve(token)
    if (identification) return identification
    identification = (async () => {
      const anonymousKey = await getAnonymousKey()
      const response = await fetchImpl(`${baseUrl}/v1/sessions/toss-anonymous`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anonymousKey }),
      })
      if (!response.ok) throw await parseError(response, 'authentication')
      const session = await response.json() as { token: string }
      token = session.token
      return session.token
    })()
    void identification.finally(() => { identification = null }).catch(() => undefined)
    return identification
  }

  const request = async <T>(path: string, init: RequestInit, mayReidentify = true): Promise<T> => {
    const sessionToken = token ?? await identify()
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${sessionToken}`)
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers })
    if (response.status === 401 && mayReidentify) {
      if (token === sessionToken) token = null
      await identify()
      return request<T>(path, init, false)
    }
    if (!response.ok) throw await parseError(response, response.status === 401 ? 'authentication' : 'endpoint')
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  const withJson = (method: 'POST' | 'PATCH', body: unknown, options?: ApiRequestOptions): RequestInit => {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options?.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey)
    return { method, headers, body: JSON.stringify(body) }
  }

  return {
    get: path => request(path, { method: 'GET' }),
    post: (path, body, options) => request(path, withJson('POST', body, options)),
    patch: (path, body) => request(path, withJson('PATCH', body)),
  }
}

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export class PendingRequestConflictError extends Error {
  constructor() {
    super('접수 여부를 확인 중인 리딩이 있어요. 입력을 바꾸기 전에 같은 내용으로 다시 확인해 주세요.')
    this.name = 'PendingRequestConflictError'
  }
}

type PendingRequest = {
  version: 1
  path: string
  body: unknown
  idempotencyKey: string
  personId?: string
}

export type RecoveredPendingRequest<T> = {
  response: T
  request: Pick<PendingRequest, 'path' | 'body' | 'idempotencyKey' | 'personId'>
}

const PENDING_KEY = 'tarororo.pending-reading-request.v1'

type PendingCoordinatorDependencies = {
  transport: Pick<ApiTransport, 'post'>
  storage: KeyValueStorage
  createKey?: () => string
}

export class PendingReadingRequestCoordinator {
  private readonly transport: Pick<ApiTransport, 'post'>
  private readonly storage: KeyValueStorage
  private readonly createKey: () => string
  private readonly inFlight = new Map<string, Promise<unknown>>()

  constructor({ transport, storage, createKey = () => crypto.randomUUID() }: PendingCoordinatorDependencies) {
    this.transport = transport
    this.storage = storage
    this.createKey = createKey
  }

  create<T>(body: unknown): Promise<T> {
    const personId = body && typeof body === 'object' && 'personId' in body && typeof body.personId === 'string' ? body.personId : undefined
    return this.start<T>('/v1/readings', body, personId)
  }

  retry<T>(readingId: string, body: unknown, personId?: string): Promise<T> {
    return this.start<T>(`/v1/readings/${encodeURIComponent(readingId)}/retry`, body, personId)
  }

  async resume<T>(): Promise<T | null> {
    return (await this.resumeWithContext<T>())?.response ?? null
  }

  async resumeWithContext<T>(): Promise<RecoveredPendingRequest<T> | null> {
    const pending = this.read()
    if (!pending) return null
    return { response: await this.send<T>(pending), request: pending }
  }

  hasPending(): boolean {
    return this.read() !== null
  }

  discard(): void {
    this.storage.removeItem(PENDING_KEY)
  }

  private async start<T>(path: string, body: unknown, personId?: string): Promise<T> {
    const existing = this.read()
    if (existing) {
      if (existing.path === path && JSON.stringify(existing.body) === JSON.stringify(body)) return this.send<T>(existing)
      throw new PendingRequestConflictError()
    }
    const pending: PendingRequest = {
      version: 1,
      path,
      body,
      idempotencyKey: this.createKey(),
      ...(personId ? { personId } : {}),
    }
    this.storage.setItem(PENDING_KEY, JSON.stringify(pending))
    return this.send<T>(pending)
  }

  private send<T>(pending: PendingRequest): Promise<T> {
    const existing = this.inFlight.get(pending.idempotencyKey)
    if (existing) return existing as Promise<T>
    const request = this.performSend<T>(pending)
    this.inFlight.set(pending.idempotencyKey, request)
    void request.finally(() => {
      if (this.inFlight.get(pending.idempotencyKey) === request) this.inFlight.delete(pending.idempotencyKey)
    }).catch(() => undefined)
    return request
  }

  private async performSend<T>(pending: PendingRequest): Promise<T> {
    try {
      const accepted = await this.transport.post<T>(pending.path, pending.body, {
        idempotencyKey: pending.idempotencyKey,
      })
      this.clearIfCurrent(pending)
      return accepted
    } catch (error) {
      if (error instanceof ApiError && error.origin === 'endpoint' && error.status < 500) this.clearIfCurrent(pending)
      throw error
    }
  }

  private clearIfCurrent(completed: PendingRequest): void {
    const current = this.read()
    if (current?.idempotencyKey === completed.idempotencyKey) this.storage.removeItem(PENDING_KEY)
  }

  private read(): PendingRequest | null {
    const raw = this.storage.getItem(PENDING_KEY)
    if (!raw) return null
    try {
      const value = JSON.parse(raw) as Partial<PendingRequest>
      if (value.version !== 1 || typeof value.path !== 'string' || !value.path.startsWith('/v1/readings') || typeof value.idempotencyKey !== 'string' || !('body' in value)) throw new Error('invalid pending request')
      return value as PendingRequest
    } catch {
      this.storage.removeItem(PENDING_KEY)
      return null
    }
  }
}
