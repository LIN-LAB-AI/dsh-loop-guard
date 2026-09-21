# dsh-loop-guard

A loop guard plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents.

It counts repeated tool calls **cumulatively across a turn** — not just consecutive runs —
and, unlike the bundled reminder, it can **enforce**: block the repeated call, or conclude
the turn.

```
cumulative:  read_a → read_b → read_a → read_c → read_a     ← counted 3, caught
consecutive: read_a → read_b → read_a → read_c → read_a     ← counted 1, missed
```

---

## What it is — and what it is not

> **`loop-guard` is not a tool for raising your success rate. It is a tool for converting
> pointless budget burn into one honest `blocked`.**

Its contract is about **how a wasted turn ends**, not about **whether the task gets solved**. When
an agent is repeating itself, the guard replaces the rest of the budget with a truthful terminal
state: the turn closes as `blocked`, with the reason recorded, instead of thrashing until the
context limit and then reporting something misleading.

The success rate *can* move — 1/8 → 6/8 in the real-model A/B further down. Read that as a **side
effect of releasing the model from a budget it was already wasting**, not as the loop being
solved. In particular, the retry closure built to "finish the job" was measured and **did not
add anything** ([details](#does-the-retry-closure-actually-help-a-real-model-ab)).

**So: adopt this plugin for the honest stop, not for the success rate.** If what you want is a
higher success rate, the lever is **bounding the task instruction** — a prompt-side change that
has nothing to do with this plugin, and by a wide margin the largest effect measured anywhere in
this repo's experiments.

---

## Why

DSH ships `@deepseek-ai/dsh-repeat-tool-reminder`, which counts *runs of consecutive calls to
the same tool with identical canonicalized arguments*. Its own README records the consequence
as a known limitation:

> **Exact-match detection only** — canonicalization is a deep key-sort, so near-identical
> variants (a tweaked path, extra whitespace inside a value) evade the chain.

That is not a corner case — it is the common shape of a real agent loop. An agent walking a
list re-issues the **same call with the same arguments**, but *interleaves other calls between
the repeats*, so a consecutive-only counter never rises above 1 and the guard never fires.

Counting the same `(tool, arguments)` key cumulatively for the turn is what actually sees it.

The same README also records the second gap:

> **Advisory only** — escalating to `block` at a high threshold **is not implemented, though
> `PostToolDecision` already supports blocking.**

This plugin wires the levers that DSH already exposes:

| Lever | Effect |
|---|---|
| `PostToolDecision` `{ kind: 'block', feedback }` | the repeated call's result becomes an error carrying corrective feedback |
| `agent/pre-step` returning `{ kind: 'reject' }` | the next step is refused and the turn closes as `blocked` |

> **A note on `concludeTurn()`, learned by running this against a real turn.**
> `ToolRunContext.concludeTurn()` looks like the natural way to end a turn from a
> `tools/post-execute` listener, and DSH's own docs point at it. **It is a silent no-op
> there.** The runtime consults the mark it sets while materializing the tool *body*
> result — which happens *before* `tools/post-execute` runs — and the post-execute path
> then re-spreads that already-materialized result, so a mark added during post-execute
> never reaches the final result. Verified by instrumenting a real turn: no
> `tools/result` ever carried `concludesTurn`, and the loop ran to completion.
> The hard stop is therefore enforced at the next `agent/pre-step` instead, which ends
> the turn with the honest reason `blocked` rather than a disguised `completed`.
> This behaviour is covered by `test/e2e.test.js`.

---

## Install

Verified end-to-end against a real DSH install: a real model, driven through
`dsh --profile`, with the plugin loaded from this documented path, produced a
`loop-guard` notice in the session log.

First install the package into the profile. `dsh plugin` forwards to `pnpm` inside the
profile directory, so a local checkout installs directly:

```sh
dsh plugin --profile web add /path/to/dsh-loop-guard
```

`dsh` warns `declares no dsh.bundle — installed as a plain dependency`. **That warning is
expected and harmless**: `dsh.bundle` is for packages that ship an entire patch *layer*
(`dsh-base`, `dsh-headless`). The bundled `dsh-repeat-tool-reminder` declares no `dsh`
field either. Individual plugins are mounted by an explicit patch entry, next.

Then add one entry to your profile's patch layer — `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
# A top-level array of loader patch entries. NOTE the `insert:` wrapper.
- insert:
    - id: loop-guard
      name: dsh-loop-guard
      config:
        mode: cumulative
        thresholds: [3, 5, 8]
        blockAt: 4
        stopAt: 6
```

> **The `insert:` wrapper is required.** A bare top-level `- id: loop-guard` is read as an
> *override* targeting an existing entry, and `dsh` reports
> `patch: entry "loop-guard" not found` and mounts nothing. Verified by dumping the tree
> both ways: without `insert:` there is a warning and no row; with it the row appears and
> the config resolves.

Restart the profile. Confirm the composed tree with:

```sh
dsh --profile web --dump-config
```

> **Note on the patch layer.** An entry whose `id` is not already in the base tree is an insert;
> an entry whose `id` matches an existing one is an override, and an override **replaces the
> `config` field wholesale** — so an override must restate the whole config. Confirm placement
> with `--dump-config` rather than assuming.

---

## Config

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `'cumulative'` \| `'consecutive'` | `cumulative` | `consecutive` reproduces the bundled reminder's behavior, so the difference is reproducible on identical input |
| `thresholds` | `number[]` | `[3, 5, 8]` | Cumulative counts that trigger an advisory. The first is gentle; later ones name the tool, the count, and the arguments |
| `blockAt` | `number` | `0` (off) | At this count, the repeated call is blocked and its result replaced by corrective feedback |
| `stopAt` | `number` | `0` (off) | At this count, stop the turn: the next step is rejected and the turn closes as `blocked` |
| **`retryAt`** | `number` | `0` (off) | At this count, stop the turn **and retry it** with one narrowed instruction instead of only closing it. The effective trigger is `min(retryAt, stopAt)` |
| **`maxRetries`** | `number` | `1` | Hard cap on retry attempts per user prompt. A new user prompt resets the count |
| **`retryInstruction`** | `string` | `''` | Extra, deployment-specific text appended to the built-in bounded instruction (`{tool}`, `{count}`, `{attempt}`, `{maxRetries}` are substituted) |
| `maxSteps` | `number` | `0` (off) | Step budget **per user prompt**; a step beyond it is rejected, closing the turn as `blocked` |
| `progressWindow` | `number` | `2` | Enforcement additionally requires that no **new** `(tool, arguments)` key has appeared for this many *steps*. `0` disables the gate |
| `include` | `string[]` | `[]` (all) | Tool-name patterns to track. `*` is a wildcard |
| `exclude` | `string[]` | `['todo_write', 'todo_read']` | Patterns **transparent** to counting — excluded calls neither count nor reset |
| `argumentsPreviewChars` | `number` | `500` | Cap on argument text quoted in the detailed reminder |

Configuration is validated **fail-loud** at mount: an empty `thresholds`, an integer below 2, a
duplicate, a negative enforcement value, or `retryAt` set with `maxRetries: 0` throws rather than
silently falling back to defaults.

### Why `exclude` matters

Excluded calls are *transparent*: they neither increment nor reset the counter. That is what
stops an agent from laundering its own loop. In `consecutive` mode,

```
read_a → todo_write → read_a → todo_write → read_a
```

counts 1 unless `todo_write` is excluded — [there is a test for exactly this](test/loop-guard.test.js).
Bookkeeping tools belong in `exclude`.

### Suggested starting config

Parity with the bundled guard, but with detection that works:

```yaml
config:
  mode: cumulative
  thresholds: [3, 5, 8]
```

Escalate to enforcement once you have watched it fire on real traffic:

```yaml
config:
  mode: cumulative
  thresholds: [3, 5]
  blockAt: 4      # stop the pointless call
  stopAt: 6       # stop the whole turn
```

Add the retry closure so that stopping does not also mean *failing to answer*:

```yaml
config:
  mode: cumulative
  thresholds: [3, 5, 8]
  blockAt: 4
  stopAt: 6
  retryAt: 6        # same point as stopAt: cap it, then hand it one bounded retry
  maxRetries: 1     # one retry, never a retry chain
```

---

## Semantics

**Counting happens in `tools/post-execute`**, so a call that was *denied* still counts — an agent
hammering a denied call is exactly the loop worth breaking.

**Counters are per agent** (keyed by the live agent object, so subagents never combine) and
**reset when a genuine user prompt enters the turn**. "Cumulative" therefore means cumulative
within one turn.

**The hard stop is applied at a step boundary, not on the result.** `stopAt` arms a stop when
the threshold is crossed and the next `agent/pre-step` refuses to enter, closing the turn as
`blocked`. It is deliberately one-shot (it does not wedge later turns) and a fresh user prompt
clears it. This does not depend on `ToolRunContext.concludeTurn()` — see the note above for why
that lever is unavailable from a post-execute listener.

**Enforcement is gated on progress; advisories are not.** `blockAt` and `stopAt` require both
the count and a stalled turn (see `progressWindow`). Because the gate delays enforcement, a
`stopAt: 4` can land later than the 4th occurrence — it fires at the first call that satisfies
*both* conditions. Notices fire on the count alone.

### Stopping is not finishing: `retryAt`

A `blocked` turn is an honest turn end, but it is not a delivered result. Measured on a real
model, the runs `stopAt` killed were precisely the runs that returned **no answer at all** — the
agent was repeating its first call and never reached the interesting part of the task. The guard
saved the budget and failed the task.

`retryAt` closes that gap. When the retry triggers:

1. The turn still closes as **`blocked`**. The reason is not disguised, and downstream consumers
   that read `turn/end` see the same honest signal they saw before.
2. One instruction is queued as a **new turn**, carrying the detected repeat, a reduced scope
   (only what is still unfinished; do not re-verify what is done), an explicit ban on repeating
   the call, a cheap sanctioned exit for unresolved uncertainty ("mark it unverified and
   continue"), and a demand for a final answer. The last attempt additionally forbids tool calls
   entirely.
3. The retry turn starts with **clean counters**, so its first call does not immediately trip the
   threshold again — otherwise the instruction would be spent before the model could act on it.

**`maxRetries` is what makes this a bound rather than a longer loop.** A retry that can itself be
retried forever is not a bound. The default is `1`: one second chance, and if the model ignores it
the turn closes as `blocked` and nothing further is queued. The counter resets on a genuine user
prompt, so the next human turn gets a fresh budget; it does **not** reset on a retry turn, or the
budget would renew itself forever.

Two DSH facts make this work, and both were established by running it rather than by reading:

- **`agent.followup()` does not open a turn while the driver is still draining the rejected turn.**
  It leaves the message parked in the inbox. The retry is therefore queued from a macrotask
  (`setTimeout(…, 0)`), which observably runs after the turn closed. A `queueMicrotask` deferral is
  *not* enough — the microtask still runs while the agent status is `running`. `test/probe-retry.js`
  demonstrates all three timings side by side.
- **A `stop` armed by the rejected turn is still set when the retry turn arrives.** Deciding "stop"
  before "is this the retry?" rejected the retry turn on arrival, before it made a single provider
  call. The retry claim is therefore checked first, and claiming it clears any pending stop.

**A fresh user prompt beats a pending retry.** If a new prompt is claimed in the same batch as a
still-pending retry instruction, the turn is treated as the prompt's turn, not as the retry:
answering a new question from the retry's narrowed scope would be worse than losing the retry.

**Notices are attributed, never laundered into a user turn.** Every injected context carries
`source: { kind: 'plugin', plugin: 'loop-guard', form: 'notice' }` with a bounded summary. Retry
instructions carry `form: 'retry'`. An unlabeled context would render in derived history as a real
user prompt.

---

## Tests

```sh
npm test          # 23 unit tests, no framework beyond node:test
npm run test:e2e  # 14 end-to-end tests against a real DSH agent turn
npm run test:all
node test/probe-retry.js   # probe, not a test: measures the Agent semantics the retry relies on
```

### Unit tests

The headline one drives **one identical call sequence** through both modes:

```js
const cumulative  = mount({ mode: 'cumulative' })
const consecutive = mount({ mode: 'consecutive' })
// both runs: read /a.txt → read other-1 → read /a.txt → read other-2 → read /a.txt
assert.equal(countNotices(await drive(cumulative)),  1)  // caught
assert.equal(countNotices(await drive(consecutive)), 0)  // missed
```

Also covered: escalation per threshold; notice attribution; `blockAt` producing a `block`
decision; `stopAt` arming a one-shot step rejection; `maxSteps` rejecting past the budget;
`exclude` transparency (both directions); argument key-order canonicalization; per-agent
isolation and reset on a user prompt; a call with no agent being ignored; preserving an
upstream `block`'s own feedback; and fail-loud config validation.

These use the plugin's **real** `Config` schema (a partial config must be completed by
schemastery, not by the caller) and the **real** `@deepseek-ai/dsh-llm` message factory. Only
`ctx` and the `exec` object are stand-ins.

### End-to-end tests

`test/e2e-harness.js` boots the **real** DSH stack in-process and stubs **only the model**:

- real `cordis` context, real event/waterfall dispatch and scope routing
- real `dsh-system-prompt`, `dsh-session`, `dsh-agent`, `dsh-tools`, `dsh-agent-loop`
- real tool pipeline, real session log, real turn/step lifecycle, real inbox

A `StubLlm` service replaces `ctx.llm` and plays a model that issues the **same two calls
alternately**, so a run of consecutive identical calls never exceeds 1. The measured outcomes
are the real ones — provider calls the loop made, `turn/end` reasons, and `tool/result` events.

| scenario | model calls | tool executions | outcome |
|---|---|---|---|
| no guard | 9 | 8 | loop runs to completion |
| `mode: consecutive`, `thresholds: [3]` | 9 | 8 | **0 notices** — the bundled rule misses it |
| `mode: cumulative`, `thresholds: [3]` | 9 | 8 | **4 notices** — caught |
| `mode: cumulative`, `blockAt: 3` | 9 | 8 | **4 error results** |
| `mode: cumulative`, `stopAt: 3` | **5** | **5** | **turn ends `blocked`** |

The `stopAt` row is the one that caught a real bug: an earlier revision relied on
`concludeTurn()` and the E2E run showed the loop still running to completion. A unit test that
only asserted the call had been made passed anyway — which is exactly why the effect is what
gets asserted now.

The retry closure has its own E2E coverage, all of it on observable effects rather than on
"the plugin called `followup()`":

| scenario | asserted effect |
|---|---|
| `retryAt: 2`, `stopAt: 2`, stubborn model | `turnStarts: 2`, retry turn really runs, `turn/end: ['blocked','blocked']` |
| retry instruction content | the text is present in the **provider request**, names the tool, reduces the scope, forbids tool calls on the last attempt |
| `maxRetries: 2`, model never relents | exactly **2** retries, **3** turns, **9** provider calls, all turns `blocked` — bounded and terminating |
| `maxRetries: 0` | **0** retries, **1** turn |
| retry counters | the retry turn answers on its **first** call (inherited counts would reject it on arrival) |
| `retryInstruction` | extra deployment text is appended without losing the built-in bound; placeholders substituted |
| two user prompts | **one retry each** — the budget is per prompt, not per agent |
| `probe-retry.js` | `followup` from a macrotask works; from a microtask or inline it does **not** |

Running these requires the `@deepseek-ai/*` packages to be resolvable.

### Does the retry closure actually help? A real-model A/B

**Short answer: the guard helps a lot; the retry closure, on this task and model, does not.**
That is reported as measured, not as intended.

Setup: `Qwen3.8-27B-Q4_0_ROCMFP4_FAST` under `llama-server`, thinking off, one model at a
time; the same B-class O(n²) instruction and the same two idempotent tools as above; the
real `dsh-agent-loop` through a real `dsh-llm` route. **The call cap of 24 lives in the
harness, not in the plugin**, so every arm is bounded identically. Each arm is 8 runs.

| arm | guard config | correct | delivered an answer | hit the call cap | stopped but no answer | retries actually performed | avg calls |
|---|---|---|---|---|---|---|---|
| **A** no guard | — | **1/8** | 1/8 | **7/8** | (n/a — nothing stops it) | 0 | 25.6 |
| **B** guard, no retry | `blockAt 4, stopAt 4, progressWindow 1` | **6/8** | 6/8 | 1/8 | 2/8 | 0 | 21.8 |
| **C** guard + retry | same + `retryAt 4, maxRetries 1` | **7/8** | 7/8 | **0/8** | **1/8** | 1 | 20.5 |
| **D** guard + retry, crisper text | same as C, `retryInstruction` = "…you MUST stop calling tools and reply with text NOW. Required reply format: first line `FINAL: <line>`…" | **4/8** | 4/8 | 0/8 | **4/8** | 4 | 18.5 |

What the numbers say, including the parts that are unflattering:

- **The guard is the whole effect.** Baseline answers 1 of 8; every guarded arm answers more.
  That is the plugin earning its place.
- **The retry closure did not add anything measurable.** C vs B is 7/8 vs 6/8 — one run, which
  is noise at this n. And of the runs where a retry was actually performed — **1 in C, 4 in D,
  5 in total — not one delivered an answer.** In all five, the retry turn really ran (the trace
  shows `claimed retry turn`), the instruction really reached the model, and the model went
  straight back to calling `check_line`.
- **A crisper instruction made it worse, not better.** D stopped the model earlier and more
  often (4 stops vs 1) and answered less than either B or C. Adding an emphatic message to a
  model that is repeating a call *because the task told it to* did not change the behaviour; it
  mostly changed when the guard fired.
- **Why the retries fire at all is the interesting part.** They do not fire on the worst loops —
  they fire on the 3–5-line scans that happen to repeat a key 4 times. `stopAt: 4` with
  `progressWindow: 1` is a sensitive trigger, and sensitivity is what makes it land on runs that
  were not doomed. The `stoponly4g1` arm lost one run to a stop at 10 calls / 3 lines covered,
  which is not a run worth interrupting.

**The honest conclusion:** the retry closure is implemented, bounded, tested, and it does
exactly what it says — it hands a stopped turn one narrowed second attempt and never more. On
this task and model it does not improve the outcome, and the mechanism lives at the mercy of
whether the model chooses to obey an injected instruction. The thing that actually worked here
was **stopping the runaway**, which is the part that already existed.

### Real-model validation

The stub model proves the plumbing. To check the claim against a real model, the same
tools and the same unbounded O(n²) instruction were driven through the real
`dsh-agent-loop` with a real `dsh-llm`/`dsh-llm-pi-ai` route to a local `llama-server`
running **Qwen3.8-35B-A3B**, 12 runs total:

| | run 1 (loop) | run 2 | run 3 |
|---|---|---|---|
| repeats | `check_line(1)×7, (2)×6, (3)×5, (4)×3` | each line ×2 | each line ×2 |
| **max cumulative** | **7** | 2 | 2 |
| **max consecutive** | **1** | 1 | 1 |
| lines reached | **7/11** | 11/11 | 11/11 |
| answer | **missed** | found | found |

**Max consecutive run was 1–2 in every one of the 12 runs** — the bundled
consecutive-only rule would never have fired, on any run. Cumulative ≥3 separates the
real loop (peak 6–7) from the legitimate path (peak 2) with no tuning.

With the guard mounted (`thresholds: [3]`, `blockAt: 4`, `stopAt: 4`):

- a real loop was cut to **12 tool calls** and the turn closed as **`blocked`** — and the
  model still produced the correct answer;
- a clean 21-call run produced **0 notices** — no false positive;
- one run hit **`max-tokens`** inside a single step with **zero tool calls**. The guard
  cannot see that: it listens on `tools/post-execute` and no tool was called. In-step
  truncation needs its own detector.
- runs stopped by `stopAt` did **not** deliver an answer. Stopping a runaway costs
  budget, not completion. `retryAt` gives that turn one bounded second attempt; measured
  on the 27B below, it fires and is delivered correctly but does not improve the outcome,
  so treat it as a budgeted second chance rather than a fix.

On the O(n²) task, notices alone changed nothing: a run that received 4–6 advisories kept
re-checking the same line. **That is not universal, though.** In the install verification
below — a task that pointlessly demanded the same read four times — a *single* advisory at
the first threshold made the model stop, refuse the remaining reads, and explain that "the
system blocked it". So an advisory is not inert: it lands hard when the repetition is
gratuitous, and is ignored when the repetition is instructionally motivated. Enforcement is
what makes the outcome independent of how the model reads the notice.

### The progress gate, and the false positive it fixes

Counting repeats is not enough to enforce on. **Measured false positive:** ask a model to
read a note file, append a line, and re-read to confirm — for three files. `read_file`
repeats with identical arguments on every cycle, which is exactly what a cumulative
counter looks for, yet the workflow is correct and every result differs because the file
changed underneath.

Same model, same task, same tools, only `progressWindow` varied:

| | blocked results | outcome |
|---|---|---|
| `progressWindow: 0` (repetition only) | **1, 1, 2** across 3 runs | **false positive every run** |
| `progressWindow: 2` (progress gate) | **0, 0, 0** | stayed out of the way |

The gate makes enforcement require stagnation, not repetition: `blockAt`/`stopAt` only
fire once no new call key has appeared for `progressWindow` calls.

**Stagnation is measured in STEPS, not calls.** A model is free to issue several calls in
one step (parallel tool calls), and a batch of reads inside a single step is *one decision*,
not a stalled turn. Counting calls made the gate open *within* a batch. This was found by
running the same experiment against a second model that batches its calls:

```
step 1:  append(α) append(β) append(γ)     <- one decision, 3 calls, all new
step 2:  read(α)   read(β)   read(γ)       <- one decision, 3 repeats... but only 1 step
step 3:  append(α) append(β) append(γ)
step 4:  read(α)   read(β)   read(γ)       <- call-counting: 2 calls since new -> BLOCKED
```

Call-counting blocked a healthy run here; step-counting does not. Measured on that model,
`progressWindow: 2`:

| | blocked results |
|---|---|
| `progressWindow: 0` (repetition only) | **3, 3, 3** |
| call-based gate | **2, 2, 2** — still a false positive |
| **step-based gate** | **0, 0, 0** |

### Results are model-dependent, and strongly so

The same task and the same guard config were run against two models. The difference is not
subtle:

| | Qwen3.8-35B-A3B (MoE) | Qwen3.8-27B FAST (dense) |
|---|---|---|
| baseline: runs that hit the call cap | 1 / 4 | **4 / 4** |
| baseline: lines covered | mostly 11/11 | **6–7 / 11 (stuck)** |
| baseline: peak same-call count | 7 / 2 / 2 / 2 | **7 / 7 / 6 / 6** |
| baseline: correct answer | 3 / 4 | **1 / 4** |
| guarded: correct answer | 2 / 4 | **6 / 10** |
| guarded: enforced (blocked) | 0–2 / 4 | 4 / 10 |
| **longest run of identical consecutive calls** | **1–2** | **1–2** |

What survives across both:
- **The consecutive-counting verdict is model-independent.** Across 18 baseline runs spanning
  both models, the longest run of identical consecutive calls never exceeded 2, so the bundled
  `repeat-tool-reminder` would have fired zero times on either. That was the premise, and it holds.
- Model choice dominates the measured effect size. The 27B loops far more reproducibly (4/4
  stuck and capped) and there the guard roughly halved the runaway rate and improved the answer
  rate. On the 35B it mostly did nothing.

Two mechanisms explain the gap, both observed directly:
- **The 35B ignores advisories; the 27B acts on them.** The 27B stopped repeating after a notice.
- **The 27B batches several calls per step; the 35B issues about one.** That batching is what
  exposed the step-vs-call bug above.

**⇒ Any single-model result about a loop guard is a statement about that model.** Treat effect
sizes here as a range, not a constant.

### The trade is real and it costs sensitivity

On the O(n²) scan the model keeps covering *new* lines, so progress often does not stall.
Across 10 real runs of that task on the 27B with the step-based gate on, the guard enforced on
**4** — two of which still delivered the answer, two of which did not. Of the 6 it left alone,
4 answered and 2 died of in-step truncation (which this plugin cannot see). Baseline on the same
model and task: **4/4 stuck, 1/4 correct**.

So the guard is a **stagnation detector**, not a repetition detector: it fires less than a
repetition counter would, and the runs it fires on are the ones burning budget without
converging. Repetition alone still drives the advisory notices — those are non-destructive and
the count is still true. If the notices are noisy on a healthy workflow, raise `thresholds`.

### What it still cannot do

- **In-step truncation.** A single generation that runs away and hits `max_tokens` makes
  **zero tool calls**, so a listener on `tools/post-execute` never sees it. Measured: one
  run ended `max-tokens` with 0 tool calls. Pair this plugin with a truncation check.
- **Hallucinated completion.** A model that asserts "all lines checked" without checking
  any produces **no repeated calls at all**, so both counting modes are blind to it. That
  needs a completion check — compare claimed work against observed work — not a loop
  detector.
- **Guaranteeing the task gets finished.** `retryAt` gives the model a bounded second
  attempt with a narrowed instruction, which is a real improvement (see the A/B table
  below) but not a guarantee: a model that ignores the instruction is stopped again. The
  retry buys a *chance* to finish within a known budget; it does not verify the answer.
`ctx` and the `exec` object are stand-ins, and their shapes were taken from DSH's own type
definitions and runtime source.

---

## Limitations

- **Detection is exact-match on canonicalized arguments.** Different arguments are a different
  key by design: an agent making genuine progress by varying its arguments will not trip this.
  The cumulative count is what catches the loop that re-issues identical calls.
- **Counters are in-memory and per turn.** A session resumed from persistence starts fresh, and
  compaction does not reset or preserve counts.
- **`stopAt` ends the turn; `retryAt` gives it one more bounded attempt.** Without the retry
  the model is told why (via the block feedback) but the work is left incomplete. With it, the
  model gets a narrowed instruction in a fresh turn; whether it accepts is up to the model, so
  pair it with a completion-verification check if you need the task actually finished.
- **`maxSteps` counts steps, not tool calls.** With parallel tool calls, one step may hold many.
- **Advisory thresholds fire only at the exact configured counts**, matching the bundled
  guard's behavior; a reminder is not repeated past the highest threshold.
- **`blockAt` replaces a result; it cannot un-run the tool body.** DSH routes a block through
  post-execute, so the call has already executed. `blockAt` stops the model *repeating*, and
  `stopAt` stops the turn; neither prevents the first execution.
- **Verified in-process against the real agent loop with a stubbed model, not against a live
  model in a running session.** The E2E suite boots the actual `dsh-agent-loop` and tool
  pipeline, so the plumbing is real; what is *not* yet covered is a real provider's chunk
  stream and a real model's behaviour over a long session.

## License

MIT
