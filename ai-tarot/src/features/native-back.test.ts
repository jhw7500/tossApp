import assert from 'node:assert/strict'
import test from 'node:test'

import { subscribeNativeBack } from './native-back.ts'

test('an internal screen routes the native back event through browser history', () => {
  let capturedEvent = ''
  let capturedHandlers: { onEvent: () => void; onError: (error: Error) => void } | undefined
  let backCalls = 0
  let cleanupCalls = 0
  const errors: Error[] = []

  const cleanup = subscribeNativeBack({
    active: true,
    subscribe: (event, handlers) => {
      capturedEvent = event
      capturedHandlers = handlers
      return () => { cleanupCalls += 1 }
    },
    goBack: () => { backCalls += 1 },
    onError: error => { errors.push(error) },
  })

  assert.equal(capturedEvent, 'backEvent')
  assert.ok(capturedHandlers)
  capturedHandlers.onEvent()
  assert.equal(backCalls, 1)
  const error = new Error('bridge unavailable')
  capturedHandlers.onError(error)
  assert.deepEqual(errors, [error])
  cleanup?.()
  assert.equal(cleanupCalls, 1)
})

test('the first screen leaves the native back event to the container', () => {
  let subscriptions = 0

  const cleanup = subscribeNativeBack({
    active: false,
    subscribe: () => {
      subscriptions += 1
      return () => undefined
    },
    goBack: () => assert.fail('root navigation must remain under container control'),
    onError: () => undefined,
  })

  assert.equal(subscriptions, 0)
  assert.equal(cleanup, undefined)
})
