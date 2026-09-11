import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  MISSING_TEXT,
  PARTIAL_TEXT,
  inspectSummary,
  normalizeTextBlocks,
  routeKey,
} from '../lib/index.js'

test('the default settings leave the feature inactive', () => {
  assert.deepEqual(Config(), { models: [] })
})

test('settings accept exact model routes and normalize removed fields away', () => {
  assert.deepEqual(Config({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
    retired: true,
  }), {
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  assert.throws(() => Config({ models: [{ provider: '', model: 'x' }] }))
})

test('route matching uses provider and model as one exact key', () => {
  assert.equal(routeKey('cotton-codex', 'gpt-5.6-luna'), 'cotton-codex\0gpt-5.6-luna')
  assert.notEqual(routeKey('cotton-codex', 'gpt-5.6-luna'), routeKey('other', 'gpt-5.6-luna'))
})

test('the first summary is normalized for relay and removed from assistant text', () => {
  const result = normalizeTextBlocks(['Before <summary>  inspected files  </summary> after'], true, 2, 3)
  assert.equal(result.summary.status, 'complete')
  assert.equal(result.summary.content, 'inspected files')
  assert.equal(result.texts[0], 'Before  after')
  assert.doesNotMatch(result.texts[0], /source="reasoning-summary"/)
})

test('a stray opening tag cannot steal the nearest complete summary pair', () => {
  const result = normalizeTextBlocks([
    'The literal <summary> token is documentation. <summary>inspected files</summary> after',
  ], true, 1, 1)
  assert.equal(result.summary.status, 'complete')
  assert.equal(result.summary.content, 'inspected files')
  assert.equal(result.texts[0], 'The literal <summary> token is documentation.  after')
})

test('a partial opening tag in an earlier text block cannot preempt a later complete pair', () => {
  const result = normalizeTextBlocks([
    'Documentation mentions a literal <summary> token.',
    '<summary>inspected src/index.ts</summary>',
  ], true, 1, 1)
  assert.equal(result.summary.status, 'complete')
  assert.equal(result.summary.content, 'inspected src/index.ts')
  assert.deepEqual(result.texts, ['Documentation mentions a literal <summary> token.', ''])
})

test('later duplicate summaries remain literal output', () => {
  const result = normalizeTextBlocks(['<summary>first</summary> body <summary status="wrong">second</summary>'], true, 1, 1)
  assert.equal(result.summary.status, 'complete')
  assert.equal(result.texts[0], ' body <summary status="wrong">second</summary>')
  assert.match(result.texts[0], /<summary status="wrong">second<\/summary>/)
  assert.equal((result.texts[0].match(/<summary/g) ?? []).length, 1)
})

test('removing a boundary summary does not leave a blank line', () => {
  const leading = normalizeTextBlocks(['<summary>planned the answer</summary>\nAnswer'], true, 1, 2)
  assert.deepEqual(leading.texts, ['Answer'])

  const trailing = normalizeTextBlocks(['Answer\n<summary>planned the answer</summary>\n'], true, 1, 2)
  assert.deepEqual(trailing.texts, ['Answer'])

  const between = normalizeTextBlocks(['Before\n<summary>planned the answer</summary>\nAfter'], true, 1, 2)
  assert.deepEqual(between.texts, ['Before\nAfter'])
})

test('missing required summaries produce relay metadata without visible markers', () => {
  const result = normalizeTextBlocks(['final answer'], true, 1, 2)
  assert.equal(result.summary.status, 'missing')
  assert.equal(result.summary.content, MISSING_TEXT)
  assert.deepEqual(result.texts, ['final answer'])
  assert.doesNotMatch(result.texts[0], /source="reasoning-summary"/)
})

test('an unclosed summary becomes partial while its received prefix stays relay-only', () => {
  const found = inspectSummary('body <summary>still working')
  assert.equal(found.info, 'partial')
  const result = normalizeTextBlocks(['body <summary>still working'], true, 4, 5)
  assert.equal(result.summary.status, 'partial')
  assert.match(result.summary.content, /still working/)
  assert.match(result.summary.content, new RegExp(PARTIAL_TEXT.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')))
  assert.deepEqual(result.texts, ['body '])
  assert.doesNotMatch(result.texts[0], /<summary/)
})

test('a final step does not add a summary when it has no tool call', () => {
  const result = normalizeTextBlocks(['ordinary final answer'], false, 1, 1)
  assert.deepEqual(result, { texts: ['ordinary final answer'] })
})
