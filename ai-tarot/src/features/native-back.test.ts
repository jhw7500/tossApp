import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasAppHistoryPredecessor,
  subscribeNativeBack,
  withAppHistoryPredecessor,
} from './native-back.ts'

test('an internal screen routes the native back event through browser history', () => {
  let capturedEvent = ''
  let capturedHandlers: { onEvent: () => void; onError: (error: Error) => void } | undefined
  let backCalls = 0
  let cleanupCalls = 0
  const errors: Error[] = []

  const cleanup = subscribeNativeBack({
    active: true,
    hasPreviousEntry: true,
    subscribe: (event, handlers) => {
      capturedEvent = event
      capturedHandlers = handlers
      return () => { cleanupCalls += 1 }
    },
    goBack: () => { backCalls += 1 },
    goToRoot: () => assert.fail('pushed navigation should use browser history'),
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

test('a recovered or direct-entry screen returns to the app root', () => {
  let capturedHandlers: { onEvent: () => void } | undefined
  let rootCalls = 0

  subscribeNativeBack({
    active: true,
    hasPreviousEntry: false,
    subscribe: (_event, handlers) => {
      capturedHandlers = handlers
      return () => undefined
    },
    goBack: () => assert.fail('a zero-depth entry must not call history.back'),
    goToRoot: () => { rootCalls += 1 },
    onError: () => undefined,
  })

  assert.ok(capturedHandlers)
  capturedHandlers.onEvent()
  assert.equal(rootCalls, 1)
})

test('history state records whether an app-owned predecessor exists', () => {
  assert.equal(hasAppHistoryPredecessor(null), false)
  assert.equal(hasAppHistoryPredecessor({ unrelated: true }), false)

  const pushed = withAppHistoryPredecessor({ unrelated: true }, true)
  assert.equal(hasAppHistoryPredecessor(pushed), true)
  assert.equal(pushed.unrelated, true)

  const replaced = withAppHistoryPredecessor(pushed, false)
  assert.equal(hasAppHistoryPredecessor(replaced), false)
})

test('the first screen leaves the native back event to the container', () => {
  let subscriptions = 0

  const cleanup = subscribeNativeBack({
    active: false,
    hasPreviousEntry: false,
    subscribe: () => {
      subscriptions += 1
      return () => undefined
    },
    goBack: () => assert.fail('root navigation must remain under container control'),
    goToRoot: () => assert.fail('root navigation must remain under container control'),
    onError: () => undefined,
  })

  assert.equal(subscriptions, 0)
  assert.equal(cleanup, undefined)
})
