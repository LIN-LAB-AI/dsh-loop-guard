/**
 * dsh-loop-guard tests.
 *
 * The headline test drives one identical call sequence through both counting modes
 * and shows the documented failure of consecutive-only detection: an agent that
 * re-issues the same call while interleaving other calls never leaves a run of 1.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { Config, apply, name } from '../lib/index.js'

/* ------------------------------------------------------------------ harness */

/**
 * Resolve a raw config through the plugin's own schema — deliberately WITHOUT
 * pre-merging defaults, so this asserts that schemastery (not the test) supplies
 * them. A real deployment writes `config: { blockAt: 3 }` and expects the rest to
 * be defaulted by the loader.
 */
function resolveConfig(raw) {
  const resolved = Config(raw)
  assert.equal(typeof resolved, 'object', 'Config(config) must return a resolved object')
  return resolved
}

/**
 * A minimal stand-in for the Cordis context: it records listeners and replays them
 * as a waterfall, in registration order, with the documented `next()` contract.
 */
function mount(raw) {
  const listeners = new Map()
  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
  }
  apply(ctx, resolveConfig(raw))

  async function waterfall(event, args, fallback) {
    const chain = listeners.get(event) ?? []
    let index = -1
    const next = async () => {
      index += 1
      if (index >= chain.length) return typeof fallback === 'function' ? fallback() : fallback
      return await chain[index](...args, next)
    }
    return await next()
  }

  return {
    postExecute: (exec, result) => waterfall('tools/post-execute', [exec, result], () => ({ kind: 'accept' })),
    preStep: (payload) => waterfall('agent/pre-step', [payload], () => ({ kind: 'enter', messages: payload.messages })),
  }
}

function makeExec(args) {
  const record = { concluded: 0 }
  const exec = {
    callId: `call-${Math.random().toString(36).slice(2, 8)}`,
    name: args.name,
    arguments: args.arguments ?? {},
    agent: args.agent,
    signal: new AbortController().signal,
    concludeTurn() {
      record.concluded += 1
    },
  }
  return { exec, record }
}

const OK = Object.freeze({ isError: false, value: null, content: [] })
const FAILED = Object.freeze({ isError: true, error: { name: 'ToolError', code: 'X' }, content: [] })

/** Count reminder notices across a whole run's decisions. */
function countNotices(decisions) {
  let total = 0
  for (const decision of decisions) {
    for (const context of decision?.additionalContexts ?? []) {
      if (context.source?.plugin === name) total += 1
    }
  }
  return total
}

/** One `grep`-style call followed by a read of a different target — the real loop shape. */
async function driveInterleavedRepeat(harness, agent) {
  const decisions = []
  for (const step of [1, 2, 3]) {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    decisions.push(await harness.postExecute(exec, OK))
    const { exec: filler } = makeExec({ name: 'read_file', arguments: { path: `/other-${step}.txt` }, agent })
    decisions.push(await harness.postExecute(filler, OK))
  }
  return decisions
}

/* -------------------------------------------------------------------- tests */

test('cumulative mode catches an interleaved repeat that consecutive mode cannot', async () => {
  const agent = {}

  const cumulative = mount({ mode: 'cumulative' })
  const cumulativeNotices = countNotices(await driveInterleavedRepeat(cumulative, agent))

  const consecutive = mount({ mode: 'consecutive' })
  const consecutiveNotices = countNotices(await driveInterleavedRepeat(consecutive, agent))

  // The same call was issued 3 times in both runs; only interleaving differed.
  assert.equal(cumulativeNotices, 1, 'cumulative detection must fire once at threshold 3')
  assert.equal(consecutiveNotices, 0, 'consecutive detection misses it, reproducing the documented limitation')
})

test('cumulative mode escalates at each configured threshold', async () => {
  const harness = mount({ thresholds: [3, 5, 7] })
  const agent = {}
  const decisions = []
  for (let i = 0; i < 7; i += 1) {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    decisions.push(await harness.postExecute(exec, OK))
  }
  assert.equal(countNotices(decisions), 3, 'one notice per threshold crossing')

  const texts = decisions
    .flatMap((decision) => decision.additionalContexts ?? [])
    .filter((context) => context.source?.plugin === name)
    .map((context) => context.content[0].text)
  assert.match(texts[0], /Carefully analyze/, 'first threshold is the gentle form')
  assert.match(texts[1], /occurrences_this_turn: 5/, 'later thresholds name the run length')
  assert.match(texts[1], /Repeated tool call detected/)
})

test('a notice is attributed to the plugin, never to the user', async () => {
  const harness = mount({})
  const agent = {}
  const decisions = []
  for (let i = 0; i < 3; i += 1) {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    decisions.push(await harness.postExecute(exec, OK))
  }
  const injected = decisions.flatMap((decision) => decision.additionalContexts ?? [])
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.kind, 'plugin')
  assert.equal(injected[0].source.plugin, name)
  assert.equal(injected[0].source.form, 'notice')
  assert.equal(injected[0].role, 'user')
})

test('blockAt turns the repeated call into corrective feedback', async () => {
  const harness = mount({ blockAt: 3 })
  const agent = {}
  const outcomes = []
  for (let i = 0; i < 3; i += 1) {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    outcomes.push(await harness.postExecute(exec, OK))
  }
  assert.equal(outcomes[0].kind, 'accept')
  assert.equal(outcomes[1].kind, 'accept')
  assert.equal(outcomes[2].kind, 'block', 'the third identical call is blocked')
  assert.ok(Array.isArray(outcomes[2].feedback) && outcomes[2].feedback.length > 0)
  assert.match(outcomes[2].feedback[0].text, /Blocked:/)
  assert.equal(outcomes[2].additionalContexts.length, 1, 'feedback and advisory both ride the block')
})

test('stopAt arms a stop that rejects the next step, closing the turn as blocked', async () => {
  const harness = mount({ stopAt: 3 })
  const agent = {}

  // Below the threshold nothing is armed, so steps keep entering.
  for (let i = 0; i < 2; i += 1) {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    await harness.postExecute(exec, OK)
    const step = await harness.preStep({ agent, messages: [], turn: 1, step: i + 1 })
    assert.equal(step.kind, 'enter', 'a step below the threshold still runs')
  }

  // The third occurrence arms the stop.
  const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
  await harness.postExecute(exec, OK)

  const stopped = await harness.preStep({ agent, messages: [], turn: 1, step: 4 })
  assert.equal(stopped.kind, 'reject', 'the next step is rejected, not the current one')

  // The stop is one-shot: it must not wedge every later turn.
  const after = await harness.preStep({ agent, messages: [], turn: 1, step: 5 })
  assert.equal(after.kind, 'enter', 'the armed stop is consumed once')
})

test('stopAt does not depend on concludeTurn being available', async () => {
  // progressWindow: 0 isolates the stop MECHANISM from the progress GATE, which has
  // its own tests below.
  const harness = mount({ stopAt: 2, progressWindow: 0 })
  const agent = {}

  // A plain ToolExecution without the ToolRunContext methods must still stop.
  const bare = {
    callId: 'c-bare',
    name: 'read_file',
    arguments: { path: '/a.txt' },
    agent,
    signal: new AbortController().signal,
  }
  await harness.postExecute(bare, OK)
  await harness.postExecute(bare, OK)

  const stopped = await harness.preStep({ agent, messages: [], turn: 1, step: 3 })
  assert.equal(stopped.kind, 'reject', 'the stop uses the step boundary, not exec.concludeTurn()')
})

test('the progress gate keeps enforcement off while a workflow keeps advancing', async () => {
  // read-modify-read: the SAME read repeats every cycle, but each cycle also issues a
  // NEW edit key, so the workflow is advancing and must never be blocked or stopped.
  const harness = mount({ blockAt: 2, stopAt: 2 })
  const agent = {}
  const outcomes = []
  for (let round = 1; round <= 4; round += 1) {
    outcomes.push(await harness.postExecute(makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent }).exec, OK))
    outcomes.push(await harness.postExecute(makeExec({ name: 'edit_file', arguments: { path: '/a.txt', n: round }, agent }).exec, OK))
    assert.equal((await harness.preStep({ agent, messages: [], turn: 1, step: round })).kind, 'enter',
      `round ${round}: a productive workflow is never cut off`)
  }
  assert.ok(outcomes.every((o) => o.kind === 'accept'), 'no call is blocked, despite 4 repeats of the same read')
})

test('the progress gate opens once the workflow stops advancing', async () => {
  const harness = mount({ blockAt: 2, stopAt: 2 })
  const agent = {}
  const read = () => makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })

  // Two distinct keys first: progress.
  await harness.postExecute(makeExec({ name: 'edit_file', arguments: { path: '/a.txt' }, agent }).exec, OK)
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'accept')

  // Now repeat with nothing new: the gate opens on the second repeat.
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'accept', 'count 2, only 1 call since new')
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'block', 'count 3, 2 calls since new -> stale')
  assert.equal((await harness.preStep({ agent, messages: [], turn: 1, step: 9 })).kind, 'reject')
})

test('progressWindow 0 restores enforcement on repetition alone', async () => {
  const harness = mount({ blockAt: 2, progressWindow: 0 })
  const agent = {}
  const read = () => makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'accept')
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'block',
    'with the gate off, the second occurrence is enough')
})

test('the progress gate measures progress in steps, not calls', async () => {
  // A model may issue several calls in ONE step (parallel tool calls). A batch of
  // repeats inside a single step is one decision, not a stalled turn -- counting
  // calls made the gate open *within* a batch and blocked a healthy run.
  const harness = mount({ blockAt: 2 })
  const agent = {}
  const read = () => makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })

  await harness.preStep({ agent, messages: [], turn: 1, step: 1 })
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'accept')

  // Three repeats of the same key, all inside step 2: the gate must stay shut.
  await harness.preStep({ agent, messages: [], turn: 1, step: 2 })
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'accept', 'repeat 2, same step')
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'accept', 'repeat 3, same step')

  // A second step still producing nothing new IS stagnation.
  await harness.preStep({ agent, messages: [], turn: 1, step: 3 })
  assert.equal((await harness.postExecute(read().exec, OK)).kind, 'block', 'a new step with no new key is stale')
})

test('a batched read-modify-read cycle is never blocked', async () => {
  // Reproduces the shape that broke call-counting: each step issues a whole batch
  // (all appends, then all reads), and every batch introduces new keys.
  const harness = mount({ blockAt: 2, stopAt: 2 })
  const agent = {}
  const call = (name, args) => makeExec({ name, arguments: args, agent }).exec

  for (let round = 1; round <= 4; round += 1) {
    await harness.preStep({ agent, messages: [], turn: 1, step: round * 2 - 1 })
    for (const path of ['/a', '/b', '/c']) {
      assert.equal((await harness.postExecute(call('append_line', { path, n: round }), OK)).kind, 'accept')
    }
    await harness.preStep({ agent, messages: [], turn: 1, step: round * 2 })
    for (const path of ['/a', '/b', '/c']) {
      assert.equal(
        (await harness.postExecute(call('read_file', { path }), OK)).kind,
        'accept',
        `round ${round}: a batched read is never blocked`,
      )
    }
  }
})

test('advisories are not gated, because the count is still true', async () => {
  const harness = mount({ thresholds: [3] })
  const agent = {}
  const outcomes = []
  // A productive read-modify-read cycle: the gate suppresses ENFORCEMENT, but the
  // 3rd repeat of the same read is still worth telling the model about.
  for (let round = 1; round <= 3; round += 1) {
    outcomes.push(await harness.postExecute(makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent }).exec, OK))
    await harness.postExecute(makeExec({ name: 'edit_file', arguments: { path: '/a.txt', n: round }, agent }).exec, OK)
  }
  const thirdRead = outcomes[2]
  assert.equal(thirdRead.kind, 'accept', 'nothing is blocked')
  assert.ok(thirdRead.additionalContexts.length > 0, 'the advisory still fires on the 3rd repeat')
})

test('a new user prompt clears an armed stop', async () => {
  const harness = mount({ stopAt: 3 })
  const agent = {}
  for (let i = 0; i < 3; i += 1) {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    await harness.postExecute(exec, OK)
  }
  await harness.preStep({ agent, messages: [{ source: { kind: 'user' } }], turn: 2, step: 1 })
  const step = await harness.preStep({ agent, messages: [], turn: 2, step: 2 })
  assert.equal(step.kind, 'enter', 'a fresh turn is not pre-empted by the previous turn stop')
})

test('maxSteps rejects the step beyond the budget and closes the turn as blocked', async () => {
  const harness = mount({ maxSteps: 6 })
  const agent = {}

  const within = await harness.preStep({ agent, messages: [], turn: 1, step: 6 })
  assert.equal(within.kind, 'enter', 'the budgeted step still runs')

  const beyond = await harness.preStep({ agent, messages: [], turn: 1, step: 7 })
  assert.equal(beyond.kind, 'reject', 'a step past the budget is rejected')
})

test('excluded bookkeeping tools cannot launder a loop', async () => {
  const agent = {}
  const calls = ['read_file', 'todo_write', 'read_file', 'todo_write', 'read_file']

  // Excluded by default: todo_write is transparent, so the three reads still count.
  const guarded = mount({})
  const decisions = []
  for (const toolName of calls) {
    const { exec } = makeExec({ name: toolName, arguments: { path: '/a.txt' }, agent })
    decisions.push(await guarded.postExecute(exec, OK))
  }
  assert.equal(countNotices(decisions), 1, 'interleaved todo_write does not hide the repeat')

  // If bookkeeping were tracked instead, it would break the consecutive chain.
  const unguarded = mount({ mode: 'consecutive', exclude: [] })
  const unguardedDecisions = []
  for (const toolName of calls) {
    const { exec } = makeExec({ name: toolName, arguments: { path: '/a.txt' }, agent })
    unguardedDecisions.push(await unguarded.postExecute(exec, OK))
  }
  assert.equal(countNotices(unguardedDecisions), 0, 'tracking todo_write resets the chain and hides the loop')
})

test('argument key order does not create a new key', async () => {
  const harness = mount({})
  const agent = {}
  const variants = [
    { path: '/a.txt', limit: 10 },
    { limit: 10, path: '/a.txt' },
    { path: '/a.txt', limit: 10 },
  ]
  const decisions = []
  for (const args of variants) {
    const { exec } = makeExec({ name: 'read_file', arguments: args, agent })
    decisions.push(await harness.postExecute(exec, OK))
  }
  assert.equal(countNotices(decisions), 1, 'all three canonicalize to one key')
})

test('counters are per agent and reset on a genuine user prompt', async () => {
  const harness = mount({ thresholds: [3] })
  const a = {}
  const b = {}

  const fire = async (agent) => {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    return harness.postExecute(exec, OK)
  }

  await fire(a)
  await fire(a)
  const third = await fire(a)
  assert.equal(countNotices([third]), 1, 'agent a reaches its own threshold')

  await fire(b)
  await fire(b)
  const bThird = await fire(b)
  assert.equal(countNotices([bThird]), 1, "agent b's counter is independent of a's")

  await harness.preStep({ agent: a, messages: [{ source: { kind: 'user' } }], turn: 2, step: 1 })
  const afterReset = await fire(a)
  assert.equal(countNotices([afterReset]), 0, 'a new user prompt restarts counting')
})

test('a call with no agent is ignored', async () => {
  const harness = mount({ blockAt: 2 })
  const decisions = []
  for (let i = 0; i < 4; i += 1) {
    const { exec, record } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent: undefined })
    decisions.push(await harness.postExecute(exec, OK))
    assert.equal(record.concluded, 0)
  }
  assert.deepEqual(
    decisions.map((decision) => decision.kind),
    ['accept', 'accept', 'accept', 'accept'],
  )
})

test('an upstream block keeps its own feedback and gains our context', async () => {
  const listeners = new Map()
  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
  }
  apply(ctx, resolveConfig({ thresholds: [3] }))
  // A downstream-of-us plugin that blocks first: register a handler that runs after ours.
  const upstreamFeedback = [{ type: 'text', text: 'upstream denial' }]
  const chain = listeners.get('tools/post-execute')
  const wrapped = [...chain]

  let index = -1
  const run = async (exec, result) => {
    index = -1
    const next = async () => {
      index += 1
      if (index >= wrapped.length) return { kind: 'block', feedback: upstreamFeedback }
      return await wrapped[index](exec, result, next)
    }
    return await next()
  }

  const agent = {}
  let last
  for (let i = 0; i < 3; i += 1) {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    last = await run(exec, OK)
  }
  assert.equal(last.kind, 'block')
  assert.equal(last.feedback, upstreamFeedback, 'the upstream feedback object is preserved')
  assert.equal(last.additionalContexts.length, 1, 'our advisory is still attached')
})

test('invalid configuration fails loud at apply time', () => {
  const bad = (raw, pattern) => {
    assert.throws(() => mount(raw), pattern)
  }
  bad({ thresholds: [] }, /must not be empty/)
  bad({ thresholds: [1] }, /integer >= 2/)
  bad({ thresholds: [3, 3] }, /duplicates/)
  bad({ argumentsPreviewChars: 0 }, /non-negative integer|integer >= 1/)
  bad({ blockAt: -1 }, /non-negative integer/)
  bad({ maxSteps: 1.5 }, /non-negative integer/)
  bad({ retryAt: -1 }, /non-negative integer/)
  bad({ maxRetries: -1 }, /non-negative integer/)
  // The schema itself rejects a non-string (schemastery's message, not ours) and `null`
  // is its "absent" value, so it resolves to the empty string rather than throwing.
  bad({ retryInstruction: 42 }, /expected string/)
  // A retry that can never be issued is a configuration mistake, not a silent no-op.
  bad({ retryAt: 4, maxRetries: 0 }, /no retry can ever be issued/)
})

test('the schema fills every default from an empty config', () => {
  const resolved = Config({})
  assert.equal(resolved.mode, 'cumulative')
  assert.deepEqual([...resolved.thresholds], [3, 5, 8])
  assert.equal(resolved.blockAt, 0)
  assert.equal(resolved.stopAt, 0)
  assert.equal(resolved.maxSteps, 0)
  assert.deepEqual([...resolved.include], [])
  assert.deepEqual([...resolved.exclude], ['todo_write', 'todo_read'])
  assert.equal(resolved.argumentsPreviewChars, 500)
  // The retry closure is OFF by default: stopping is the shipped behaviour, retrying is opt-in.
  assert.equal(resolved.retryAt, 0)
  assert.equal(resolved.maxRetries, 1)
  assert.equal(resolved.retryInstruction, '')
})

test('a partial config is completed by the schema, not by the caller', async () => {
  // Exactly what a deployment writes: one field, everything else defaulted.
  const harness = mount({ blockAt: 3 })
  const agent = {}
  const outcomes = []
  for (let i = 0; i < 3; i += 1) {
    const { exec } = makeExec({ name: 'read_file', arguments: { path: '/a.txt' }, agent })
    outcomes.push(await harness.postExecute(exec, OK))
  }
  assert.equal(outcomes[2].kind, 'block', 'blockAt took effect with every other field defaulted')
})

test('the reported plugin name matches the package name', () => {
  assert.equal(name, 'loop-guard')
})
