/**
 * dsh-loop-guard — loop detection with **cumulative** counting and real enforcement.
 *
 * Why this exists
 * ---------------
 * The bundled `@deepseek-ai/dsh-repeat-tool-reminder` counts runs of *consecutive*
 * calls to the same tool with *identical* canonicalized arguments, and its own README
 * lists the consequence as a known limitation: "Exact-match detection only — near-identical
 * variants (a tweaked path, extra whitespace inside a value) evade the chain."
 *
 * Measured on real agent runs, that is the difference between catching nothing and
 * catching the loop: an agent that walks a list re-issues the *same* call with the
 * *same* arguments, but interleaves other calls between repeats, so a
 * consecutive-only counter never leaves 1. Counting the same `(tool, arguments)`
 * key **cumulatively across the turn** is what actually sees it.
 *
 * This plugin also does what the bundled guard deliberately does not: it can
 * *enforce*. Its README says "escalating to `block` at a high threshold is not
 * implemented, though `PostToolDecision` already supports blocking." Two levers
 * are wired here — a `block` decision (corrective feedback delivered as an error
 * result) and a hard stop that rejects the next step, closing the turn as
 * `blocked`.
 *
 * Enforcement is gated on progress, not repetition alone. Counting repeats will
 * happily fire on a read-modify-read cycle: the agent re-reads the same path after
 * every edit, so `(read, {path})` repeats, yet every result differs and the work is
 * advancing. `blockAt`/`stopAt` therefore require that no NEW `(tool, arguments)` key
 * has appeared for `progressWindow` calls. Advisories stay ungated — the count is
 * still true, and a reminder is non-destructive.
 *
 * A note on the hard stop, learned by running this against a real turn:
 * `ToolRunContext.concludeTurn()` is NOT usable from a `tools/post-execute`
 * listener. The runtime consults the mark it sets while materializing the tool
 * BODY result, which happens before this waterfall runs, and the post-execute
 * path then re-spreads that already-materialized result — so the call is a silent
 * no-op. The stop is therefore enforced at `agent/pre-step`, a documented way for
 * a plugin to close a turn. See `observe()`.
 *
 * Retry
 * -----
 * Stopping is not finishing. Measured against a real model, runs the guard killed
 * with `stopAt` were the runs that delivered NO answer: the agent was repeating its
 * first call and never reached the interesting part of the task. `blocked` is an
 * honest turn end, but it is not a delivered result.
 *
 * `retryAt` closes that gap with a BOUNDED retry, and the bound is the whole point —
 * a retry that is itself unbounded is just a longer loop. At most `maxRetries`
 * retry attempts are ever issued per user prompt; the counter resets when a genuine
 * user prompt arrives, so the next human turn gets a fresh budget.
 *
 * Each retry is a separate turn carrying one narrowed instruction: the detected
 * repeat, the scope reduced to what is still unfinished, an explicit ban on
 * repeating, a cheap way out of unresolved uncertainty ("mark it unverified and
 * move on" — the fuel of these loops is unresolved doubt, not verbosity), and a
 * demand for a final answer. The last attempt is stricter: no more tool calls at
 * all, answer from what you already have.
 *
 * Two DSH facts make this work, both established by running it, not by reading:
 *
 * 1. `agent.followup()` called while the driver is still draining the rejected turn
 *    leaves the message parked in the inbox and opens NO new turn. A rejection at
 *    `agent/pre-step` discards the batch it had already claimed and closes the turn;
 *    anything queued before that teardown finishes is never claimed. The retry is
 *    therefore queued from a macrotask (`setTimeout(…, 0)`), which observably runs
 *    after the turn closed (`agent.status === 'idle'`). A `queueMicrotask` deferral
 *    is NOT enough — the microtask runs while the driver is still `running`.
 * 2. The retry turn must reset the per-turn counters. Inherited counts would make the
 *    very first call of the retry turn exceed the threshold again, spending the whole
 *    retry budget without the model ever seeing the instruction do its work.
 *
 * Semantics
 * ---------
 * Detection listens on `tools/post-execute`, so a call that was denied still counts:
 * an agent hammering a denied call is exactly the loop worth breaking.
 *
 * Counters are per agent (keyed by the live agent object) and reset when a genuine
 * user prompt enters the turn, so "cumulative" means cumulative *within one turn*.
 *
 * @module dsh-loop-guard
 */
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'

export const name = 'loop-guard'

export const Config = z.object({
  /**
   * Counting mode. `cumulative` counts every occurrence of a `(tool, arguments)`
   * key across the turn; `consecutive` counts only an unbroken run, which is what
   * the bundled reminder does. Exposed so the difference is reproducible on
   * identical input rather than only asserted.
   */
  mode: z.union([z.const('cumulative'), z.const('consecutive')]).default('cumulative'),

  /** Cumulative counts that trigger an advisory reminder. First is gentle, later ones detailed. */
  thresholds: z.array(z.number()).default([3, 5, 8]),

  /**
   * At this cumulative count, block the repeated call: its result is replaced by
   * corrective feedback as an error. 0 disables blocking.
   */
  blockAt: z.number().default(0),

  /**
   * At this cumulative count, conclude the turn. 0 disables the hard stop.
   *
   * Enforced by rejecting the NEXT step at `agent/pre-step`, which closes the turn
   * as `blocked`. See `observe()` for why `ToolRunContext.concludeTurn()` cannot be
   * used from this listener.
   */
  stopAt: z.number().default(0),

  /** Per-turn step budget. A step beyond it is rejected, closing the turn as `blocked`. 0 disables. */
  maxSteps: z.number().default(0),

  /**
   * Cumulative count at which the guard stops the turn *and retries it* instead of
   * just closing it. 0 disables the retry closure (the pre-0.4 behaviour: `blocked`
   * is the end of the story).
   *
   * Stopping is not finishing. Measured on a real model, the runs `stopAt` killed
   * were precisely the runs that returned no answer at all. When `retryAt` is set,
   * reaching that count rejects the next step — the turn still closes as `blocked`,
   * which stays honest — and then queues one bounded instruction as a fresh turn.
   *
   * The effective trigger is `min(retryAt, stopAt)` when `stopAt` is also set, so a
   * retry can be made to fire earlier than the hard stop. With `retryAt` alone
   * (`stopAt: 0`) the retry is the only enforcement, and there is no hard stop to
   * fall back on once the retry budget is exhausted.
   */
  retryAt: z.number().default(0),

  /**
   * Hard cap on retry attempts per user prompt. The default of 1 is a deliberate
   * refusal to trade one unbounded loop for another: a retry that can itself be
   * retried forever is not a bound, it is a longer loop.
   *
   * Each attempt is its own turn with its own scope. Once the budget is spent the
   * turn closes as `blocked` and nothing further is queued. A new user prompt
   * resets the counter.
   */
  maxRetries: z.number().default(1),

  /**
   * Extra, task-specific text appended to the built-in bounded instruction — this is
   * the lever for telling the agent what "unfinished" means in this deployment
   * (`{tool}`, `{count}`, `{attempt}`, `{maxRetries}` are substituted).
   *
   * The built-in text already carries the four parts that matter (what was detected,
   * the reduced scope, the ban on repeating, and the demand for a conclusion). Use
   * this to add domain vocabulary; do not use it to soften the bound.
   */
  retryInstruction: z.string().default(''),

  /**
   * Progress gate for enforcement. `blockAt` and `stopAt` additionally require that no
   * NEW `(tool, arguments)` key has appeared for this many tracked calls.
   *
   * Without the gate, enforcement fires on repetition alone — which is wrong for any
   * workflow that legitimately repeats a call while the world changes underneath it.
   * The canonical example is read-modify-read: a coding agent reads a file, edits it,
   * reads it again to verify, edits again. The `(read, {path})` key repeats every time,
   * but every result differs and the agent is making progress. A cumulative counter
   * alone blocks or kills that run.
   *
   * The gate is what distinguishes "repeating because it is stuck" from "repeating
   * because the task is inherently iterative". Advisory notices are NOT gated: they are
   * non-destructive and the count is still true.
   *
   * 0 disables the gate (enforce on repetition alone, the pre-0.2 behaviour).
   */
  progressWindow: z.number().default(2),

  /** Tool-name patterns to track; empty tracks every tool. `*` is a wildcard. */
  include: z.array(z.string()).default([]),

  /**
   * Tool-name patterns transparent to counting — excluded calls neither count nor
   * reset. Bookkeeping tools belong here: without it, an agent that interleaves
   * `todo_write` between repeats launders its own loop.
   */
  exclude: z.array(z.string()).default(['todo_write', 'todo_read']),

  /** Cap on the argument text quoted in the detailed reminder. */
  argumentsPreviewChars: z.number().default(500),
})

/** Stamped on every notice, per the plugin-source contract (an unlabeled context renders as a user prompt). */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

const GENTLE_REMINDER =
  'You are repeating a tool call you have already made in this turn. Carefully analyze the ' +
  'previous result before calling again: if the task is not complete, try a different approach ' +
  'or different arguments instead of repeating the call.'

function detailedReminder(toolName, count, canonicalArguments) {
  return (
    `Repeated tool call detected:\n` +
    `- tool: ${toolName}\n` +
    `- occurrences_this_turn: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    `You have made this exact call ${count} times in this turn and it is not making progress. ` +
    `Do not call this tool with these arguments again. Inspect the latest result and choose a ` +
    `different action, different arguments, or finish the task if enough evidence has been gathered.`
  )
}

function blockedFeedback(toolName, count) {
  return (
    `Blocked: you have called \`${toolName}\` with these exact arguments ${count} times in this ` +
    `turn. Repeating it cannot produce new information. Use the results you already have, change ` +
    `your arguments or approach, or report what you found and what remains unknown.`
  )
}

/**
 * The bounded scope line of a retry instruction.
 *
 * The measured reason these loops do not converge is that the instruction is
 * unbounded, and their fuel is *unresolved uncertainty*: a cheap sanctioned exit
 * ("mark it unverified and continue") does most of the work. `stopAt` is only the
 * second-order fix. So the retry text states the reduced scope AND the exit.
 */
function retryScope(attempt, maxRetries) {
  const last = attempt >= maxRetries
  return (
    'Scope for this attempt:\n' +
    '- Only handle the work that is still unfinished. Do NOT re-verify, re-read or re-check ' +
    'anything you have already completed.\n' +
    '- Do not issue the same tool call with the same arguments twice. If a call would repeat, ' +
    'treat its result as already known and move on.\n' +
    (last
      ? '- This is the final attempt. Do not call any tool at all: answer from the results you ' +
        'already have, even if they are incomplete.\n'
      : '- If something remains unresolved, mark it explicitly as unverified and continue. Do not ' +
        'keep investigating it.\n')
  )
}

/**
 * The whole retry instruction: what was detected, the reduced scope, and the demand
 * for a conclusion. `{tool}`, `{count}`, `{attempt}`, `{maxRetries}` are substituted
 * in the caller-supplied `retryInstruction`, which is appended after the built-in text.
 */
function retryInstructionText({ toolName, count, attempt, maxRetries, extra }) {
  const head =
    `Loop retry ${attempt} of ${maxRetries}: your previous attempt kept repeating the same tool ` +
    `call instead of finishing the task.\n` +
    `- repeated call: ${toolName}\n` +
    `- occurrences before the stop: ${count}\n`
  const tail =
    '\nFinish the task now, then state your final answer in plain text in your reply. A partial ' +
    'answer that is clearly labeled is worth far more than another verification pass.'
  const custom = typeof extra === 'string' && extra.trim() !== ''
    ? `\n${extra
        .replaceAll('{tool}', toolName)
        .replaceAll('{count}', String(count))
        .replaceAll('{attempt}', String(attempt))
        .replaceAll('{maxRetries}', String(maxRetries))}`
    : ''
  return head + retryScope(attempt, maxRetries) + custom + tail
}

/** Deep key-sort so two argument objects differing only in property order canonicalize identically. */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key])
    return sorted
  }
  return value
}

/** Canonical string form of a call's arguments. Falls back to a raw string when arguments are not JSON. */
function canonicalize(argumentsValue) {
  try {
    const canonical = JSON.stringify(sortJsonValue(argumentsValue))
    return canonical === undefined ? String(argumentsValue) : canonical
  } catch {
    return String(argumentsValue)
  }
}

/** Compile one `*`-wildcard pattern to an anchored RegExp; every other metacharacter is literal. */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Head-truncate the canonical arguments for quoting; bounds only the model-visible text. */
function previewArguments(canonical, cap) {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/** Fail-loud threshold validation, normalized ascending. */
function validateThresholds(values) {
  if (values.length === 0) throw new Error('loop-guard: `thresholds` must not be empty')
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`loop-guard: invalid threshold ${value} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) throw new Error('loop-guard: `thresholds` must not contain duplicates')
  return [...values].sort((a, b) => a - b)
}

/** Build the model-visible notice for one observation. */
function notice(text, summary) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary: boundContextSummary(summary) },
  })
}

/** Prepend our context while preserving every downstream context's source and metadata. */
function prependContext(ours, theirs) {
  return ours === undefined ? theirs : [ours, ...(theirs ?? [])]
}

/** Opt-in trace, used by the retry tests to observe the guard's own decisions. */
const TRACE = process.env.LOOP_GUARD_TRACE === '1' ? (...args) => console.error('[guard]', ...args) : null

/** Install the guard's listeners. */
export function apply(ctx, config) {
  const thresholds = validateThresholds(config.thresholds)
  const thresholdSet = new Set(thresholds)
  const includePatterns = config.include.map(wildcardToRegExp)
  const excludePatterns = config.exclude.map(wildcardToRegExp)
  const argumentsPreviewChars = config.argumentsPreviewChars
  const mode = config.mode
  const blockAt = config.blockAt
  const stopAt = config.stopAt
  const maxSteps = config.maxSteps
  const progressWindow = config.progressWindow
  const retryAt = config.retryAt
  const maxRetries = config.maxRetries
  const retryInstruction = config.retryInstruction

  for (const [label, value] of [
    ['argumentsPreviewChars', argumentsPreviewChars],
    ['blockAt', blockAt],
    ['stopAt', stopAt],
    ['maxSteps', maxSteps],
    ['progressWindow', progressWindow],
    ['retryAt', retryAt],
    ['maxRetries', maxRetries],
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`loop-guard: invalid ${label} ${value} — must be a non-negative integer`)
    }
  }
  if (argumentsPreviewChars < 1) {
    throw new Error(`loop-guard: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`)
  }
  if (typeof retryInstruction !== 'string') {
    // Unreachable through the schema, which already rejects a non-string; kept because
    // `apply` is also callable with a hand-built config that bypassed it.
    throw new Error('loop-guard: `retryInstruction` must be a string')
  }
  if (retryAt > 0 && stopAt === 0 && maxRetries === 0) {
    throw new Error(
      'loop-guard: `retryAt` is set but `maxRetries` is 0, so no retry can ever be issued — ' +
        'set `maxRetries` >= 1 or disable `retryAt`',
    )
  }

  /**
   * The count at which the retry fires. `retryAt` on its own is the trigger; with a
   * `stopAt` also configured the earlier of the two wins, so a retry can be made to
   * fire before the hard stop.
   */
  const retryTrigger = retryAt === 0
    ? 0
    : stopAt === 0
      ? retryAt
      : Math.min(retryAt, stopAt)

  /**
   * Per-agent counting state.
   *
   * `counts` is the cumulative map used in `cumulative` mode; `lastKey`/`lastCount`
   * carry the consecutive run used in `consecutive` mode. `seen` + `calls` +
   * `lastNewAt` drive the progress gate in both modes: `seen` holds every key issued
   * this turn, so a call whose key is absent is genuinely new information and moves
   * `lastNewAt` up to the current call index.
   */
  const states = new WeakMap()

  /**
   * Agents whose turn the guard has decided to end. Populated in post-execute and
   * consumed at the next `agent/pre-step`, which is the earliest point the loop can
   * actually be stopped from a plugin (see `observe`).
   */
  const stopRequested = new WeakSet()

  function stateFor(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = {
        counts: new Map(),
        seen: new Set(),
        calls: 0,
        /** Current agent step, tracked from `agent/pre-step`. 0 = not yet observed. */
        step: 0,
        /** Call index at which the most recent NEW key appeared. */
        lastNewAt: 0,
        /** Step at which the most recent NEW key appeared. */
        lastNewStep: 0,
        lastKey: undefined,
        lastCount: 0,
        /** Retry attempts issued against the current user prompt. Reset by a new user prompt. */
        retries: 0,
        /**
         * Which user prompt this state belongs to. A step budget is per USER PROMPT, not
         * per turn, so steps are counted from the genuine user message and re-based when
         * a retry turn starts — otherwise the retry inherits the first turn's consumed
         * budget and is rejected on arrival.
         */
        cycle: 0,
        /**
         * Step numbers restart at 1 for every turn, so a per-cycle total needs the sum of
         * the turns that already ran in this cycle. Rebuilt from the observed step
         * sequence: a step number that fails to advance means a new turn began.
         */
        stepOffset: 0,
        lastStep: 0,
        /** Highest step number seen in the turn currently open. */
        stepHigh: 0,
        /** Counters of the LAST stop that requested a retry, quoted in the instruction. */
        lastToolName: '',
        lastRepeatCount: 0,
        /**
         * Set when a retry instruction has been queued. The next `agent/pre-step` that
         * claims it is the retry turn, and inheriting the previous turn's counters would
         * make its very first call exceed the threshold again — spending the whole retry
         * budget before the instruction can do any work. Cleared on consumption.
         */
        retryPending: false,
      }
      states.set(agent, state)
    }
    return state
  }

  /** Counters that must start clean on a new attempt (a fresh user prompt or a retry turn). */
  function resetCounters(state) {
    state.counts.clear()
    state.seen.clear()
    state.calls = 0
    state.lastNewAt = 0
    state.lastNewStep = 0
    state.lastKey = undefined
    state.lastCount = 0
    state.lastToolName = ''
    state.lastRepeatCount = 0
  }

  /** Whether a tool participates in counting (untracked calls are transparent: neither count nor reset). */
  function tracked(toolName) {
    if (includePatterns.length > 0 && !includePatterns.some((pattern) => pattern.test(toolName))) return false
    return !excludePatterns.some((pattern) => pattern.test(toolName))
  }

  /**
   * Advance the calling agent's counters and decide what to do about this attempt.
   * @returns `undefined` when nothing is due, else the notice and the enforcement flags.
   */
  function observe(exec) {
    if (exec.agent === undefined || exec.agent === null) return undefined
    if (!tracked(exec.name)) return undefined

    const canonical = canonicalize(exec.arguments)
    const key = `${exec.name}\u0000${canonical}`
    const state = stateFor(exec.agent)

    state.calls += 1
    if (!state.seen.has(key)) {
      state.seen.add(key)
      state.lastNewAt = state.calls
      state.lastNewStep = state.step
    }

    let count
    if (mode === 'consecutive') {
      count = state.lastKey === key ? state.lastCount + 1 : 1
      state.lastKey = key
      state.lastCount = count
    } else {
      count = (state.counts.get(key) ?? 0) + 1
      state.counts.set(key, count)
    }

    // Progress gate. Enforcement requires that the turn has stopped producing new
    // information. A read-modify-read cycle repeats `(read, {path})` on every pass
    // while every result differs, so repetition alone does not mean a loop.
    //
    // Staleness is measured in STEPS, not calls. A model is free to issue several
    // calls in one step (parallel tool calls), and a batch of reads inside a single
    // step is ONE decision, not a stalled turn. Counting calls made the gate open
    // *within* a batch: measured against a model that batches its appends and reads
    // into separate steps, call-counting blocked a healthy run. Fall back to
    // call-counting only before the first step has been observed.
    const stale =
      progressWindow === 0 ||
      (state.step > 0
        ? state.step - state.lastNewStep >= progressWindow
        : state.calls - state.lastNewAt >= progressWindow)
    const block = stale && blockAt > 0 && count >= blockAt
    const stop = stale && stopAt > 0 && count >= stopAt
    const retryDue = stale && retryTrigger > 0 && count >= retryTrigger && state.retries < maxRetries

    // A hard stop cannot be applied here. `ToolRunContext.concludeTurn()` only marks
    // the execution: the runtime consults that mark while materializing the *body*
    // result, which happens BEFORE this waterfall runs, and the post-execute path
    // then re-spreads that already-materialized result. Calling it from a
    // `tools/post-execute` listener is therefore a silent no-op — verified against a
    // real turn. Record the intent instead and reject the next step, which is a
    // documented way for a plugin to close a turn.
    if (stop || retryDue) {
      stopRequested.add(exec.agent)
      state.lastToolName = exec.name
      state.lastRepeatCount = count
    }
    // The retry BUDGET is spent in the `pre-step` that enacts this decision, not here:
    // `retryDue` is recomputed on every further repeat, so consuming it here would let
    // two halves of the same decision each take one attempt off the budget.

    let message
    if (thresholdSet.has(count)) {
      const text =
        count === thresholds[0]
          ? GENTLE_REMINDER
          : detailedReminder(exec.name, count, previewArguments(canonical, argumentsPreviewChars))
      message = notice(text, `${exec.name} × ${count}`)
    }

    if (!message && !block && !stop && !retryDue) return undefined
    return { message, block, stop, retryDue, count }
  }

  /**
   * Counting happens in post-execute because denied calls flow through this
   * waterfall too — a model hammering a denied call is exactly the loop worth breaking.
   */
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const plan = observe(exec)
    if (plan === undefined) return downstream

    const additionalContexts = prependContext(plan.message, downstream.additionalContexts)

    // Block: the corrective feedback replaces this call's result as an error.
    // An upstream block keeps its own feedback; we only add context.
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts }
    }
    if (plan.block) {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: blockedFeedback(exec.name, plan.count) }],
        additionalContexts,
      }
    }
    return { ...downstream, additionalContexts }
  })

  /**
   * A genuine user prompt starts a new turn's counting; a retry turn resets the
   * counters but keeps the retry budget; a requested hard stop or an exhausted step
   * budget closes a runaway turn as `blocked`.
   */
  ctx.on('agent/pre-step', ({ agent, messages, step }, next) => {
    if (agent !== undefined && agent !== null && messages.some((message) => message.source?.kind === 'user')) {
      states.delete(agent)
      stopRequested.delete(agent)
    }

    if (agent !== undefined && agent !== null) {
      const state = stateFor(agent)

      // Step numbers restart at 1 for every turn, so `stepOffset` accumulates the turns
      // that already ran in this cycle, making `step + stepOffset` a per-CYCLE total.
      // Without it the step budget is silently per-turn, and a retry would get a fresh
      // budget instead of sharing the cycle's one.
      //
      // `state.step` keeps the PREVIOUS step number, not the one about to run: a step's
      // calls are observed before the *next* `pre-step`, so advancing it here would let
      // the progress gate open too early. It stays 0 until a step has actually been
      // observed, which is what keeps the call-count fallback working for the first step.
      if (typeof step === 'number') {
        if (step < state.step) state.stepOffset += state.stepHigh
        state.step = step
        if (step > state.stepHigh) state.stepHigh = step
      }

      // IS this the retry turn? This check MUST come before the stop check. The retry
      // instruction is queued from a macrotask that can land a step or two late, and a
      // `stopRequested` armed by those extra repeats is still set when the retry turn
      // arrives — deciding "stop" first rejected the retry turn on arrival, before it
      // made a single provider call, which is exactly the failure the retry exists to
      // prevent. Claiming the retry therefore also clears any pending stop.
      //
      // It also must NOT be a batch carrying a genuine user prompt. A new human prompt
      // can be claimed together with a still-pending retry instruction; treating that
      // turn as the retry would answer the new prompt from the retry's narrowed scope.
      // A fresh user prompt wins outright — that is what "reset on a new prompt" means.
      const isRetryTurn =
        state.retryPending &&
        messages.some((message) => message.source?.form === 'retry') &&
        !messages.some((message) => message.source?.kind === 'user')
      if (isRetryTurn) {
        if (TRACE) TRACE('claimed retry turn', { step, retries: state.retries })
        state.retryPending = false
        resetCounters(state)
        // `state.step` is a per-cycle total, so seed the staleness anchors with it;
        // leaving them at 0 would make the progress gate open on the retry turn's
        // first call and stop the retry before the model can act on the instruction.
        state.lastNewStep = state.step
        state.lastNewAt = state.calls
        stopRequested.delete(agent)
        state.cycle += 1
        return next()
      }

      if (stopRequested.has(agent)) {
        stopRequested.delete(agent)
        if (TRACE) {
          TRACE('pre-step stop', { step, retries: state.retries, retryPending: state.retryPending,
            claimed: messages.map((m) => m.source?.form ?? m.source?.kind ?? '?') })
        }
        // Budget left: queue a retry instruction as a NEW turn (see below for why it
        // cannot be queued inline) and still close this one as `blocked` — an honest
        // reason, and the retry is a separate turn with its own scope.
        if (retryAt > 0 && state.retries < maxRetries) {
          state.retries += 1
          state.retryPending = true
          const pending = { toolName: state.lastToolName, count: state.lastRepeatCount, attempt: state.retries }
          // Queued from a macrotask, NOT inline and NOT from a microtask. Measured:
          // `followup()` while the driver is still draining this rejected turn leaves
          // the message parked in the inbox and opens no turn at all; a macrotask runs
          // after the turn has closed (`agent.status === 'idle'`) and does open one.
          setTimeout(() => {
            if (TRACE) TRACE('queue retry', { attempt: pending.attempt, status: agent.status })
            agent.followup(
              createUserMessage({
                content: [
                  { type: 'text', text: retryInstructionText({ ...pending, maxRetries, extra: retryInstruction }) },
                ],
                source: {
                  ...PLUGIN_SOURCE,
                  form: 'retry',
                  summary: boundContextSummary(`loop retry ${pending.attempt}/${maxRetries}`),
                },
              }),
            )
          }, 0)
        }
        return { kind: 'reject' }
      }

      if (maxSteps > 0 && typeof step === 'number' && state.step > maxSteps) {
        return { kind: 'reject' }
      }
    }

    return next()
  })
}
