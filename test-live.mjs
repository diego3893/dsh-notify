/**
 * 用真实通知链路的"交付"环节验证插件：确认四类事件真的会走到投递，
 * 且投递内容正确。
 *
 * 为什么不用"队列文件还在不在"来判断：插件投递后会拉起常驻通道，通道会在几百毫秒内
 * 把 item 文件消费掉（这本身是通道正常的表现）。所以这里用插件提供的 `onDeliver`
 * 测试钩子观察投递事件，结果与竞态无关。
 *
 * 用法:
 *   node test-live.mjs            只验证交付（队列目录独立，通常不会弹气泡）
 *   node test-live.mjs --real     让常驻通道真的弹一条气泡（会看到右下角通知）
 *
 * 退出码: 0 = 通过，1 = 失败
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './lib/index.js'

const real = process.argv.includes('--real')
// 每次运行一个独立目录，不与正在使用的队列相互干扰。
const queueDir = real
  ? path.join(os.tmpdir(), 'dsh-notify-queue')
  : path.join(os.tmpdir(), `dsh-notify-plugin-test-${process.pid}`)
fs.rmSync(queueDir, { recursive: true, force: true })

const delivered = []
const listeners = new Map()
const ctx = {
  on(event, handler) {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
  logger: () => ({ info: () => {}, warn: (message) => console.error('warn:', message) }),
  effect() {},
}

apply(ctx, {
  queueDir,
  idleMs: 0,
  notifyGapMs: 0,
  onDeliver: (item) => delivered.push(item),
})

const agent = { id: 's1', session: { header: { cwd: process.cwd() }, title: '通道实测' } }

// 1) 审批请求：必须旁听 + 原样透传 answerer 的决定。
const approvalOutcome = await listeners.get('approval/request')(
  { agent, toolName: 'write', reason: '真实通道验证' },
  () => Promise.resolve('rejected'),
)
assert.equal(approvalOutcome, 'rejected', '插件必须调用 next() 并透传 answerer 的决定')
assert.match(delivered.at(-1).title, /授权/, `审批通知标题不对: ${delivered.at(-1).title}`)
assert.match(delivered.at(-1).body, /write/, '审批通知正文应带工具名')
assert.match(delivered.at(-1).body, /真实通道验证/, '审批通知正文应带申请理由')

// 2) 提问请求：同样透传，并带上问题原文。
const answer = { answers: [{ id: 'q1', selected: ['x'] }] }
const questionOutcome = await listeners.get('user-questions/request')(
  { agent, questions: [{ id: 'q1', question: '产物要放到哪个目录？' }] },
  () => Promise.resolve(answer),
)
assert.deepEqual(questionOutcome, answer, '提问决定必须原样透传')
assert.match(delivered.at(-1).title, /等你回答/, '提问通知标题不对')
assert.match(delivered.at(-1).body, /产物要放到哪个目录/, '提问通知正文应带问题原文')

// 3) agent/error。
listeners.get('agent/error')({ agent, error: new Error('model request failed') })
assert.match(delivered.at(-1).title, /执行出错/, '报错通知标题不对')

console.log(`队列目录: ${queueDir}`)
console.log(`交付的通知（${delivered.length} 条）:`)
for (const item of delivered) console.log(`  - ${item.title} :: ${item.body.replace(/\n/g, ' | ')}`)
assert.equal(delivered.length, 3, `应交付 3 条通知，实际 ${delivered.length} 条`)
console.log('插件交付链路验证：通过 ✓')

if (real) {
  console.log('（--real：已写入真实队列目录，常驻通道会真的弹出这些气泡）')
} else {
  fs.rmSync(queueDir, { recursive: true, force: true })
  console.log('（已清理本次专属队列目录）')
}
