/**
 * dsh-notify 插件的离线自检：用假的 cordis Context 驱动插件，
 * 断言四类事件各自触发一条通知、且都不会抛异常或吞掉 next()。
 *
 * 用法: node test-plugin.mjs
 */
import assert from 'node:assert/strict'
import { apply } from './lib/index.js'

function makeContext() {
  const listeners = new Map()
  const logs = []
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    logger(name) {
      return {
        info: (message) => logs.push(`info ${name}: ${message}`),
        warn: (message) => logs.push(`warn ${name}: ${message}`),
      }
    },
    effect(factory) {
      ctx.disposers.push(factory())
    },
    disposers: [],
  }
  return { ctx, listeners, logs }
}

const agent = {
  id: 'session-fixture-1',
  // cwd 只用来生成"会话：<工作区名>"这段文案，用当前目录即可，避免写死机器路径。
  session: { header: { cwd: process.cwd() }, title: '通知插件自检' },
}

const sent = []
const { ctx, listeners, logs } = makeContext()
apply(ctx, { sender: (title, body, options) => sent.push({ title, body, options }), idleMs: 5 })

assert.ok(listeners.has('approval/request'), '应注册 approval/request')
assert.ok(listeners.has('user-questions/request'), '应注册 user-questions/request')
assert.ok(listeners.has('agent/status'), '应注册 agent/status')
assert.ok(listeners.has('agent/error'), '应注册 agent/error')

// 1) 审批请求：通知 + 必须把决定权交给后面的 answerer。
let delegated = false
const outcome = await listeners.get('approval/request')(
  { agent, toolName: 'write', reason: 'escalate sandbox to danger-full-access: 需要写工作区之外' },
  () => {
    delegated = true
    return Promise.resolve('allowed-once')
  },
)
assert.equal(outcome, 'allowed-once', '审批决定必须原样透传')
assert.equal(delegated, true, '必须调用 next() 交给真正的 answerer')
assert.equal(sent.at(-1).title, '⚠ DSH 需要你授权')
assert.match(sent.at(-1).body, /write/)
assert.match(sent.at(-1).body, /需要写工作区之外/)

// 2) 提问请求：通知 + 透传答案。
let questionAnswer
const answer = await listeners.get('user-questions/request')(
  { agent, questions: [{ id: 'q1', question: '产物要放到哪个目录？' }] },
  () => Promise.resolve({ answers: [{ id: 'q1', selected: ['x'] }] }),
)
questionAnswer = answer
assert.deepEqual(questionAnswer, { answers: [{ id: 'q1', selected: ['x'] }] })
assert.equal(sent.at(-1).title, '❓ DSH 在等你回答')
assert.match(sent.at(-1).body, /产物要放到哪个目录/)

// 3) 运行 → 空闲：等 debounce 之后才提示；运行中不提示。
listeners.get('agent/status')({ agent, status: 'running' })
const before = sent.length
listeners.get('agent/status')({ agent, status: 'idle' })
await new Promise((resolve) => setTimeout(resolve, 40))
assert.equal(sent.length, before + 1, '空闲后应恰好补一条结束通知')
assert.equal(sent.at(-1).title, '✅ DSH 这一轮任务结束了')

// 3b) 空闲后又立刻运行：不应提示。
listeners.get('agent/status')({ agent, status: 'idle' })
listeners.get('agent/status')({ agent, status: 'running' })
await new Promise((resolve) => setTimeout(resolve, 40))
assert.equal(sent.at(-1).title, '✅ DSH 这一轮任务结束了', '取消的结束通知不应再补发')
assert.equal(sent.filter((n) => n.title === '✅ DSH 这一轮任务结束了').length, 1)

// 4) agent 报错。
listeners.get('agent/error')({ agent, error: new Error('model request failed') })
assert.equal(sent.at(-1).title, '⛔ DSH 执行出错')
assert.match(sent.at(-1).body, /model request failed/)

// 5) 释放：清理 debounce 定时器不抛异常。
for (const disposer of ctx.disposers) await disposer?.()

console.log(`通过：${sent.length} 条通知，事件类型全部命中`)
for (const item of sent) console.log(`  - ${item.title} :: ${item.body.replace(/\n/g, ' | ')}`)
if (logs.length > 0) console.log(logs.join('\n'))
