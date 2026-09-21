/**
 * PROBE, not a regression test — `npm run test:all` does not include this file.
 *
 * It measures the three DSH `Agent` semantics that the `retryAt` closure depends on,
 * because the retry design was derived from these observations rather than from
 * documentation. Run it with `node test/probe-retry.js` after an upgrade of the
 * `@deepseek-ai/*` packages: if any of these lines changes, the retry logic must change
 * with it.
 *
 * What it establishes:
 *
 *   A. `agent.followup()` called while the driver is still draining a rejected turn
 *      leaves the message PARKED in the inbox and opens NO new turn. The retry is
 *      therefore queued from `setTimeout(..., 0)`, which observably runs after the turn
 *      closed. A `queueMicrotask` deferral is not enough — the microtask still runs
 *      while the agent status is `running`.
 *
 *   B. Queuing it in the SAME turn as the rejection does not rescue it either: the
 *      rejected turn's teardown discards what it already claimed.
 *
 *   C. A retry instruction whose `source.kind` is not `'user'` is not mistaken for a new
 *      user prompt, which is what keeps "reset the retry budget on a new user prompt"
 *      from freeing the budget on every retry.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

function toolCallChunk(index, name, args) {
  return [
    {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: `probe-${index}-${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunk(text) {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class StubLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.streamCalls = 0
    this.retrySeenByModel = false
  }
  async prepareCall(config) {
    return { config, stream: (request) => this.stream(request) }
  }
  async *stream(request) {
    this.streamCalls += 1
    if (JSON.stringify(request ?? {}).includes('RETRY-INSTRUCTION')) this.retrySeenByModel = true
    for (const chunk of this.script(this.streamCalls, request)) yield chunk
  }
  listProviders() { return ['stub'] }
  providerInfo() { return undefined }
  providerRetryPolicy() { return undefined }
  async listModels() { return [] }
  async resolveModel(provider, model) { return { provider, model } }
}

const settle = () => new Promise((r) => setTimeout(r, 200))

async function boot(label) {
  const app = new Context()
  app.plugin(SystemPrompt, {})
  app.plugin(SessionStore, {})
  app.plugin(SessionStore, {})
  app.plugin(AgentRegistry, {})
  app.plugin(ToolRuntime, {})
  app.plugin(StubLlm)
  app.plugin(AgentLoop, { maxParallelToolCalls: 1 })
  await settle()
  console.log(`\n================ ${label} ================`)
  const record = { executions: 0 }
  app.get('tools').register(defineTool({
    name: 'loop_probe',
    description: 'records one observation',
    parameters: { key: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) { record.executions += 1; return `observed ${args.key}` },
  }))
  const handle = await app.get('agents').create({
    sessionId: `probe-${Math.random().toString(36).slice(2, 8)}`,
    agentOptions: { provider: 'stub', model: 'stub-model' },
  })
  return { app, handle, agent: handle.agent, record, llm: app.get('llm') }
}

function summarize(agent, llm, record, extra = '') {
  const log = agent.session.log ?? []
  const events = log.filter((e) => ['turn/start', 'turn/end'].includes(e.type))
    .map((e) => `${e.type}${e.data?.reason?.kind ? ':' + e.data.reason.kind : ''}`).join(' -> ') || '(none)'
  console.log(`  ${extra}turn 事件        :`, events)
  console.log(`  ${extra}模型请求数      :`, llm.streamCalls)
  console.log(`  ${extra}工具执行数      :`, record.executions)
  console.log(`  ${extra}★ 重试指令到达模型:`, llm.retrySeenByModel)
  console.log(`  ${extra}inbox nextTurn  :`, JSON.stringify((agent.inbox?.nextTurn ?? []).map((m) => (m.content?.[0]?.text ?? '').slice(0, 24))))
}

// ---------- A/B: 同步 / 微任务 / 宏任务 三种入队时机的差别
for (const [label, defer] of [
  ['同步(在同一 listener 里直接 followup)', (fn) => fn()],
  ['queueMicrotask', (fn) => queueMicrotask(fn)],
  ['setTimeout 0(插件实际采用)', (fn) => setTimeout(fn, 0)],
]) {
  const { app, handle, agent, record, llm } = await boot(`入队时机 = ${label}`)
  let stopArmed = false
  let retries = 0
  llm.script = (n) => (n > 3 ? textChunk('DONE') : toolCallChunk(0, 'loop_probe', { key: 'A' }))

  const queue = () => defer(() => {
    console.log(`    [defer] status=${agent.status} -> followup`)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'RETRY-INSTRUCTION 收窄范围,直接给结论' }],
      source: { kind: 'plugin', plugin: 'probe', form: 'retry' },
    }))
  })

  app.on('tools/post-execute', async (exec, result, next) => {
    const down = await next()
    if (record.executions >= 2) { stopArmed = true; if (retries < 1) { retries += 1; queue() } }
    return down
  })
  app.on('agent/pre-step', ({ agent: a, messages, step }, next) => {
    console.log(`    [pre-step] step=${step} claimed=[${messages.map((m) => m.source?.form ?? m.source?.kind ?? '-')}]`)
    if (a && messages.some((m) => m.source?.kind === 'user')) stopArmed = false
    if (a && stopArmed) { stopArmed = false; return { kind: 'reject' } }
    return next()
  })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await new Promise((r) => setTimeout(r, 700))
  summarize(agent, llm, record)
  await handle.dispose()
}

// ---------- C: 重试指令的 source.kind 会不会被当成新用户 prompt
{
  const { app, handle, agent, record, llm } = await boot('重试指令的 source:重试 turn 是否被误判为「新用户 prompt」')
  const batches = []
  app.on('agent/pre-step', ({ messages, step }, next) => {
    batches.push({ step, kinds: messages.map((m) => m.source?.kind ?? '(none)'), forms: messages.map((m) => m.source?.form ?? '-') })
    return next()
  })
  llm.script = (n) => (n > 3 ? textChunk('DONE') : toolCallChunk(0, 'loop_probe', { key: 'A' }))

  app.on('tools/post-execute', async (exec, result, next) => {
    const down = await next()
    if (record.executions >= 2 && !agent.inbox.nextTurn.length) {
      setTimeout(() => agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'RETRY-INSTRUCTION 收窄范围' }],
        source: { kind: 'plugin', plugin: 'probe', form: 'retry' },
      })), 0)
    }
    return down
  })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await new Promise((r) => setTimeout(r, 700))
  console.log('  pre-step 观测到的 batch:')
  for (const b of batches) console.log(`    step=${b.step} kinds=${JSON.stringify(b.kinds)} forms=${JSON.stringify(b.forms)}`)
  console.log('  ★ 重试 turn 的 source.kind 是否为 user:', batches.some((b) => b.forms.includes('retry') && b.kinds.includes('user')))
  summarize(agent, llm, record)
  await handle.dispose()
}

// ---------- D: steer 能不能替代 setTimeout+followup
// `steer()` 的文档说「idle driver 会同步起一轮」,如果它在关轮过程中也能生效,重试就不必
// 依赖宏任务时机。实测结果决定插件用哪个原语。
{
  const { app, handle, agent, record, llm } = await boot('备选原语: 在同一 listener 里 steer')
  let stopArmed = false
  let steered = false
  llm.script = (n) => (n > 3 ? textChunk('DONE') : toolCallChunk(0, 'loop_probe', { key: 'A' }))

  app.on('tools/post-execute', async (exec, result, next) => {
    const down = await next()
    if (record.executions >= 2) {
      stopArmed = true
      if (!steered) {
        steered = true
        exec.agent.steer(createUserMessage({
          content: [{ type: 'text', text: 'RETRY-INSTRUCTION 收窄范围,直接给结论' }],
          source: { kind: 'plugin', plugin: 'probe', form: 'retry' },
        }))
        console.log('    [steer] 已入队;status =', exec.agent.status)
      }
    }
    return down
  })
  app.on('agent/pre-step', ({ agent: a, messages, step }, next) => {
    console.log(`    [pre-step] step=${step} claimed=[${messages.map((m) => m.source?.form ?? m.source?.kind ?? '-')}]`)
    if (a && messages.some((m) => m.source?.kind === 'user')) stopArmed = false
    if (a && stopArmed) { stopArmed = false; return { kind: 'reject' } }
    return next()
  })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await new Promise((r) => setTimeout(r, 700))
  summarize(agent, llm, record)
  await handle.dispose()
}

process.exit(0)
