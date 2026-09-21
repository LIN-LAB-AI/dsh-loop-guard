/**
 * End-to-end tests: the guard running inside a REAL DSH agent turn.
 *
 * These are the tests that justify the plugin's claims, because they measure the
 * real loop rather than a fake context:
 *
 *   - the scripted model issues the SAME two calls alternately, so a run of
 *     consecutive identical calls never exceeds 1;
 *   - `modelCalls` is the real number of provider calls the loop made;
 *   - `turnEnds` is the real recorded `turn/end` reason;
 *   - `erroredResults` counts real `tool/result` events carrying an error.
 *
 * Only the model is stubbed. Everything else is the shipped implementation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { runScenario, toolCallChunk, textChunk } from './e2e-harness.js'

test('e2e: baseline — an unguarded looping agent runs every scripted call', async () => {
  const r = await runScenario({ guardConfig: null, calls: 8 })
  assert.equal(r.executions, 8, 'the tool body really ran 8 times')
  assert.equal(r.keys, 'ABABABAB', 'the model repeated the same two calls')
  assert.equal(r.modelCalls, 9, '8 tool-calling steps plus the final answer')
  assert.equal(r.notices, 0, 'no guard, no notices')
  assert.equal(r.erroredResults, 0, 'every call succeeded')
  assert.deepEqual(r.turnEnds, ['completed'])
})

test('e2e: consecutive counting misses the loop, reproducing the bundled limitation', async () => {
  const r = await runScenario({ guardConfig: { mode: 'consecutive', thresholds: [3] }, calls: 8 })
  assert.equal(r.notices, 0, 'alternating keys never form a consecutive run, so nothing fires')
  assert.equal(r.modelCalls, 9, 'the loop runs to completion undetected')
  assert.deepEqual(r.turnEnds, ['completed'])
})

test('e2e: cumulative counting catches the very same loop', async () => {
  const r = await runScenario({ guardConfig: { mode: 'cumulative', thresholds: [3] }, calls: 8 })
  assert.ok(r.notices > 0, `expected advisories, got ${r.notices}`)
  assert.equal(r.modelCalls, 9, 'advisories alone do not stop the loop — that is blockAt/stopAt')
})

test('e2e: blockAt turns repeated calls into real error results', async () => {
  const r = await runScenario({ guardConfig: { mode: 'cumulative', blockAt: 3 }, calls: 8 })
  // Keys A and B each reach 3 on their third occurrence (calls 5 and 6) and stay
  // at or above the threshold for their fourth (calls 7 and 8): four blocks.
  assert.equal(r.erroredResults, 4, 'exactly the calls at or past the threshold are blocked')
  assert.equal(r.executions, 8, 'blocking replaces the result; it does not un-run the body')
  assert.ok(r.blockedTexts.length > 0, 'the block carries corrective feedback to the model')
  assert.match(r.blockedTexts[0], /^Blocked:/)
})

test('e2e: stopAt ends the turn early and records it as blocked', async () => {
  const baseline = await runScenario({ guardConfig: null, calls: 8 })
  const guarded = await runScenario({ guardConfig: { mode: 'cumulative', stopAt: 3 }, calls: 8 })

  assert.ok(
    guarded.modelCalls < baseline.modelCalls,
    `guard must cut the loop short: ${guarded.modelCalls} vs ${baseline.modelCalls}`,
  )
  assert.equal(guarded.modelCalls, 5, "key A's third occurrence lands on the 5th call")
  assert.equal(guarded.keys, 'ABABA')
  assert.deepEqual(guarded.turnEnds, ['blocked'], 'an honest reason, not a disguised completion')
})

test('e2e: stopAt stops at the threshold regardless of how long the loop would run', async () => {
  const long = await runScenario({ guardConfig: null, calls: 12 })
  const guarded = await runScenario({ guardConfig: { mode: 'cumulative', stopAt: 3 }, calls: 12 })
  assert.equal(long.modelCalls, 13, 'unguarded, the longer script runs longer')
  assert.equal(guarded.modelCalls, 5, 'guarded, the stop point does not move')
  assert.deepEqual(guarded.turnEnds, ['blocked'])
})

test('e2e: maxSteps bounds a turn that has no repeats at all', async () => {
  // A distinct key every step: repetition detection cannot help here, only a budget can.
  const r = await runScenario({
    guardConfig: { maxSteps: 3 },
    calls: 8,
  })
  assert.ok(r.modelCalls <= 4, `step budget must bound the turn, got ${r.modelCalls} calls`)
  assert.deepEqual(r.turnEnds, ['blocked'])
})

// ---------------------------------------------------------------------------
// retryAt / maxRetries — the bounded retry closure.
//
// These assert on OBSERVABLE effects only: how many turns the driver really ran,
// what the session log recorded, and what the provider request actually contained.
// "the plugin called followup()" is not evidence that a retry happened.
// ---------------------------------------------------------------------------

test('e2e: retryAt gives a capped-out run a second turn instead of ending it', async () => {
  const config = { mode: 'cumulative', stopAt: 2, retryAt: 2, maxRetries: 1 }
  const withoutRetry = await runScenario({ guardConfig: { mode: 'cumulative', stopAt: 2 }, calls: 8 })
  const withRetry = await runScenario({ guardConfig: config, calls: 8 })

  // No retry: the stop ends the story after 4 provider calls, and the model never
  // delivers the answer text it would have produced at call 9.
  assert.deepEqual(withoutRetry.turnEnds, ['blocked'])
  assert.equal(withoutRetry.retryCount, 0)
  assert.equal(withoutRetry.modelCalls, 4)

  // With retry: the turn still closes as `blocked` (honest), and then a second turn
  // really runs because the guard queued the instruction. This scripted model never
  // takes the hint, so it is stopped again — but it got its bounded second attempt,
  // which is exactly what the closure promises and no more.
  assert.deepEqual(withRetry.turnEnds, ['blocked', 'blocked'])
  assert.equal(withRetry.retryCount, 1, 'exactly one retry turn really ran')
  assert.equal(withRetry.turnStarts, 2, 'the retry was a second real turn')
  assert.equal(withRetry.modelCalls, 8, 'the retry turn really issued provider calls')
  assert.equal(withRetry.turnError, null, 'and it did not die of an unrelated error')
})

test('e2e: the retry instruction reaches the MODEL and is bounded in scope', async () => {
  const r = await runScenario({
    guardConfig: { mode: 'cumulative', stopAt: 2, retryAt: 2, maxRetries: 1 },
    calls: 8,
  })

  assert.equal(r.retryReachedModel, true, 'the retry text must be in a real provider request, not just the session log')
  assert.equal(r.retryTexts.length, 1)
  assert.equal(r.turnError, null, 'the run must not fail for an unrelated reason')
  const text = r.retryTexts[0]
  assert.match(text, /Loop retry 1 of 1/)
  assert.match(text, /loop_probe/, 'it names the call that was repeating')
  assert.match(text, /unfinished/, 'it reduces the scope to what is left')
  assert.match(text, /do not call any tool at all/i, 'the final attempt forbids further tool calls')
})

test('e2e: maxRetries bounds the retry — a stubborn model cannot loop forever', async () => {
  // A model that never stops calling the tool, no matter what it is told.
  const r = await runScenario({
    guardConfig: { mode: 'cumulative', stopAt: 2, retryAt: 2, maxRetries: 2 },
    script: () => toolCallChunk(0, 'loop_probe', { key: 'A' }),
  })

  assert.equal(r.retryCount, 2, 'exactly maxRetries retries, not one more')
  assert.equal(r.turnStarts, 3, 'the original turn plus two retry turns')
  assert.deepEqual(r.turnEnds, ['blocked', 'blocked', 'blocked'], 'every turn ends honestly')
  // Three turns, each stopped after 3 provider calls (the third is the one that trips
  // the threshold), and then nothing further: the budget is spent and the third turn is
  // closed without a fourth. Bounded, and it terminates.
  assert.equal(r.modelCalls, 9)
  assert.equal(r.turnError, null)
})

test('e2e: maxRetries 0 disables the retry outright', async () => {
  const r = await runScenario({
    guardConfig: { mode: 'cumulative', stopAt: 2, retryAt: 2, maxRetries: 0 },
    script: () => toolCallChunk(0, 'loop_probe', { key: 'A' }),
  })
  assert.equal(r.retryCount, 0)
  assert.equal(r.turnStarts, 1)
  assert.deepEqual(r.turnEnds, ['blocked'])
})

test('e2e: a retry starts its counters clean, so it is not dead on arrival', async () => {
  // The retry turn answers on its FIRST model call. If the previous turn's counts were
  // inherited, that call would already be past the threshold and the retry would be
  // rejected before the model ever acted on the instruction.
  const r = await runScenario({
    guardConfig: { mode: 'cumulative', stopAt: 2, retryAt: 2, maxRetries: 1 },
    script: (n) => (n > 3 ? textChunk('final answer: 8') : toolCallChunk(0, 'loop_probe', { key: 'A' })),
  })
  assert.deepEqual(r.turnEnds, ['blocked', 'completed'], `unexpected: ${JSON.stringify(r.turnEnds)} err=${r.turnError} calls=${r.modelCalls} retry=${r.retryCount}`)
  assert.equal(r.retryCount, 1)
  // Turn 1 used 3 provider calls (2 tool calls + the third that trips the stop), and
  // the retry turn answered on its first call.
  assert.equal(r.modelCalls, 4)
})

test('e2e: retryInstruction adds deployment vocabulary without losing the built-in bound', async () => {
  const r = await runScenario({
    guardConfig: {
      mode: 'cumulative',
      stopAt: 2,
      retryAt: 2,
      maxRetries: 1,
      retryInstruction: 'The 11 config lines are the units of work; {tool} was repeated {count} times.',
    },
    calls: 8,
  })
  const text = r.retryTexts[0]
  assert.match(text, /The 11 config lines are the units of work/)
  assert.match(text, /loop_probe was repeated 2 times/, 'placeholders are substituted')
  assert.match(text, /Only handle the work that is still unfinished/, 'the built-in bound is still present')
})

test('e2e: a new user prompt resets the retry budget', async () => {
  // Two user prompts on one agent: the second loops again and must get its own retry.
  // If the budget lived on the agent instead of the prompt, "bounded" would mean
  // "bounded once per agent", which is not a bound at all.
  //
  // The script identifies the turn STRUCTURALLY from the request, because the transcript
  // is cumulative and keeps old material: the retry instruction stays in history forever,
  // so searching the whole request for it matches later turns too. Instead:
  //   - the provider request's LAST message says which kind of turn this is
  //     (`source.kind === 'tool'` means the turn is mid-loop, otherwise it is opening);
  //   - the last genuine user message says which prompt is being answered.
  //
  // Each prompt repeats the tool call 4 times. The fourth is where `stopAt: 2` actually
  // trips: the progress gate measures staleness in STEPS, and the first step falls back
  // to counting calls, so the gate is not open before the 4th call of the turn. That is
  // the guard's real cadence, not a test artefact.
  const loopCallsByPrompt = new Map()
  const r = await runScenario({
    guardConfig: { mode: 'cumulative', stopAt: 2, retryAt: 2, maxRetries: 1 },
    script: (n, request) => {
      const messages = request?.messages ?? []
      const last = messages[messages.length - 1]
      const userTexts = messages
        .filter((m) => m.source?.kind === 'user')
        .flatMap((m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text))
      const prompt = userTexts.at(-1) === 'go again' ? 2 : 1
      if (last?.source?.kind === 'tool') {
        const seen = (loopCallsByPrompt.get(prompt) ?? 0) + 1
        loopCallsByPrompt.set(prompt, seen)
        return seen < 4 ? toolCallChunk(0, 'loop_probe', { key: 'A' }) : textChunk('concluded')
      }
      // Opening a turn: the retry turn concludes at once, an original turn starts looping.
      return userTexts.includes('Loop retry 1 of 1')
        ? textChunk('concluded from the retry instruction')
        : toolCallChunk(0, 'loop_probe', { key: 'A' })
    },
    secondPrompt: true,
    secondPromptText: 'go again',
  })
  assert.equal(r.retryCount, 2, 'one retry per user prompt, not one per agent')
  assert.equal(r.turnStarts, 4, 'two original turns plus one retry each')
  assert.deepEqual(
    r.turnEnds,
    ['blocked', 'completed', 'blocked', 'completed'],
    `unexpected: ${JSON.stringify(r.turnEnds)} retry=${r.retryCount} calls=${r.modelCalls} err=${r.turnError}`,
  )
  assert.equal(r.turnError, null)
})

