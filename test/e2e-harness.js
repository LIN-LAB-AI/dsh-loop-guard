/**
 * End-to-end harness: boots the REAL DSH agent stack in-process and stubs only the
 * model.
 *
 *   real cordis Context + real event/waterfall dispatch and scope routing
 *   real dsh-system-prompt / dsh-session / dsh-agent / dsh-tools / dsh-agent-loop
 *   real tool pipeline (pre-execute -> execute -> post-execute -> result)
 *   real session log, real turn/step lifecycle, real inbox and send primitives
 *
 * Only the `llm` service is stubbed. A guard's listeners therefore run through the
 * same machinery they would in a live session, and the observable outcomes are the
 * real ones: how many model calls the loop made, what the session log recorded, and
 * why the turn ended.
 *
 * Precondition: the `@deepseek-ai/*` DSH packages must be resolvable. In a DSH
 * deployment they sit in its own node_modules; see the README's testing section.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

/**
 * One complete tool-call block, then a `tool-calls` finish.
 *
 * The call id MUST be unique per call. A looping script legitimately issues the same
 * tool with the same arguments many times, and a fixed synthetic id made the runtime
 * reject the second one — the turn then ended as `error` instead of exercising the
 * guard at all. That failure looked exactly like a guard bug and was not one.
 */
let callIdSeq = 0
export function toolCallChunk(index, name, args) {
  callIdSeq += 1
  return [
    {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: `call-${index}-${name}-${callIdSeq}`, name, arguments: JSON.stringify(args) },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** One text block, then a `stop` finish — how the scripted model ends its turn. */
export function textChunk(text) {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * The stubbed model. It counts its own calls — one `stream()` call is one step —
 * and emits whatever `script(callNumber, request)` returns.
 */
export class StubLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.streamCalls = 0
    this.script = () => textChunk('done')
  }

  setScript(script) {
    this.script = script
    this.streamCalls = 0
  }

  async prepareCall(config) {
    // The loop reads `preparedCall.config` and calls `preparedCall.stream(request)`.
    return { config, stream: (request) => this.stream(request) }
  }

  async *stream(request) {
    this.streamCalls += 1
    for (const chunk of this.script(this.streamCalls, request)) yield chunk
  }

  // The remaining service shape the runtime may probe.
  listProviders() {
    return ['stub']
  }
  providerInfo() {
    return undefined
  }
  providerRetryPolicy() {
    return undefined
  }
  async listModels() {
    return []
  }
  async resolveModel(provider, model) {
    return { provider, model }
  }
}

/** A tool whose body counts how many times it really executed. */
function probeTool(record) {
  return defineTool({
    name: 'loop_probe',
    description: 'Records one observation. Calling it again with the same key cannot reveal anything new.',
    parameters: { key: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args) {
      record.executions += 1
      record.keys.push(args.key)
      return `observed ${args.key}`
    },
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

/**
 * Boot the stack and run one turn against a scripted looping model.
 *
 * @param guardConfig - config for the guard, or null to run without it.
 * @param calls - how many tool calls the default scripted model issues before
 *   answering. It alternates two distinct argument sets, so a consecutive-only counter
 *   never exceeds a run of 1.
 * @param script - optional replacement for the scripted model:
 *   `(modelCall, request) => chunks`. `request` is the raw provider request, so a test
 *   can assert on what the model actually RECEIVED (the injected retry instruction, for
 *   instance) rather than on "the plugin called some function".
 * @param secondPrompt - queue a second genuine user prompt after the first settles.
 * @param firstPromptText / secondPromptText - those prompts' texts, so a scripted model
 *   can tell which prompt it is answering.
 * @param debugTurnEnds - print every `turn/end` payload as it is recorded.
 */
export async function runScenario({
  guardConfig = null,
  calls = 8,
  guardPath = '../lib/index.js',
  script = null,
  requestObserver = null,
  idleGraceMs = 600,
  secondPrompt = false,
  secondPromptGraceMs = 600,
  firstPromptText = 'go',
  secondPromptText = 'go again',
  debugTurnEnds = false,
} = {}) {
  const app = new Context()

  app.plugin(SystemPrompt, {})
  app.plugin(SessionStore, {})
  app.plugin(AgentRegistry, {})
  app.plugin(ToolRuntime, {})
  app.plugin(StubLlm)
  app.plugin(AgentLoop, { maxParallelToolCalls: 1 })
  await settle()

  if (guardConfig !== null) {
    const guard = await import(guardPath)
    app.plugin(guard, guardConfig)
    await settle()
  }

  const record = { executions: 0, keys: [] }
  app.get('tools').register(probeTool(record))

  const llm = app.get('llm')
  const requests = []
  llm.setScript((n, request) => {
    // The request object is what the provider really received: it is how a test proves
    // the retry instruction reached the MODEL rather than only the session log.
    try {
      requests.push(JSON.stringify(request ?? {}))
    } catch {
      requests.push('')
    }
    if (requestObserver !== null) requestObserver(n, request)
    if (script !== null) return script(n, request, record)
    return n > calls
      ? textChunk('I have gathered enough evidence.')
      : toolCallChunk(0, 'loop_probe', { key: n % 2 === 1 ? 'A' : 'B' })
  })

  const handle = await app.get('agents').create({
    sessionId: `e2e-${Math.random().toString(36).slice(2, 10)}`,
    agentOptions: { provider: 'stub', model: 'stub-model' },
  })
  const agent = handle.agent
  let turnError = null

  if (debugTurnEnds) {
    app.on('session/event', (event) => {
      if (event?.type === 'turn/end') console.log('[debug] turn/end:', JSON.stringify(event.data).slice(0, 600))
    })
  }

  agent.followup(
    createUserMessage({ content: [{ type: 'text', text: firstPromptText }], source: { kind: 'user' } }),
  )
  try {
    await agent.whenIdle()
  } catch (error) {
    turnError = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
  }
  // A retry instruction is queued from a macrotask and opens its own turn; give the
  // driver room to drain it before reading the log.
  await new Promise((resolve) => setTimeout(resolve, idleGraceMs))

  if (secondPrompt) {
    // Wait until the agent is genuinely quiescent BEFORE queuing the second prompt.
    // `whenIdle()` alone is not enough: a retry instruction is queued from a macrotask,
    // so it can still be sitting in the `nextTurn` inbox. Queuing a prompt into that
    // window makes the driver claim both together, and the second prompt would then be
    // answered inside the retry turn instead of starting a turn of its own.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (agent.status !== 'idle' || (agent.inbox?.nextTurn ?? []).length > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    agent.followup(
      createUserMessage({ content: [{ type: 'text', text: secondPromptText }], source: { kind: 'user' } }),
    )
    try {
      await agent.whenIdle()
    } catch (error) {
      turnError = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
    }
    await new Promise((resolve) => setTimeout(resolve, secondPromptGraceMs))
  }

  const log = agent.session.log ?? []
  const results = []
  // A `tool/result` carries the model-facing projection in `message.content[0]`, and the
  // error flag lives on the inner `tool-result` block (not on `data.error`, which is the
  // optional INTERNAL failure identity and is absent for a post-execute block).
  for (const entry of log) {
    if (entry.type !== 'tool/result') continue
    const block = entry.data?.message?.content?.[0]
    results.push({
      isError: block?.isError === true,
      text: block?.content?.[0]?.text ?? '',
    })
  }

  const notices = log.filter((entry) => JSON.stringify(entry.data ?? {}).includes('"plugin":"loop-guard"')).length
  const turnEnds = log.filter((entry) => entry.type === 'turn/end').map((entry) => entry.data?.reason?.kind)

  // The retry instruction is a real queued user-role message on the session log, so
  // counting it here counts retries the runtime actually performed. A `user/message`
  // session entry stores the message fields directly under `data`.
  const retryMessages = log.filter(
    (entry) => entry.type === 'user/message' && entry.data?.source?.form === 'retry',
  )
  const retryTexts = retryMessages.map((entry) =>
    (entry.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
  )

  await handle.dispose()

  return {
    modelCalls: llm.streamCalls,
    executions: record.executions,
    keys: record.keys.join(''),
    notices,
    erroredResults: results.filter((r) => r.isError).length,
    blockedTexts: results.filter((r) => r.isError).map((r) => r.text),
    turnEnds,
    turnEndData: log.filter((entry) => entry.type === 'turn/end').map((entry) => entry.data),
    turnError,
    turnStarts: log.filter((entry) => entry.type === 'turn/start').length,
    retryCount: retryMessages.length,
    retryTexts,
    /** True when the retry instruction was present in a request the provider received. */
    retryReachedModel: requests.some((s) => s.includes('Loop retry')),
    requests,
  }
}
