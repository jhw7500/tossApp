import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./lan-crypto.js', import.meta.url), 'utf8')

test('HTTP browser UUIDs use secure random bytes with UUID v4 version and variant', () => {
  let calls = 0
  const crypto = { getRandomValues: bytes => { calls++; return bytes.fill(255) } }
  runInNewContext(source, { crypto, Math: { random: () => { throw new Error('insecure randomness') } } })
  assert.equal(crypto.randomUUID(), 'ffffffff-ffff-4fff-bfff-ffffffffffff')
  assert.equal(crypto.randomUUID(), 'ffffffff-ffff-4fff-bfff-ffffffffffff')
  assert.equal(calls, 2)
})

test('HTTPS and localhost retain the browser native implementation', () => {
  const native = () => 'native-uuid'
  const crypto = { randomUUID: native }
  runInNewContext(source, { crypto })
  assert.equal(crypto.randomUUID, native)
})
