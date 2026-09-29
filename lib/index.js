/**
 * dsh-notify 插件（Host 侧）。
 *
 * 挂到 DSH 自己的事件面上，在需要人介入的时刻弹 Windows 托盘气泡：
 *   - approval/request       需要你授权 / 审批
 *   - user-questions/request 需要你回答问题
 *   - agent/status           会话从运行转入空闲 → 这一轮任务结束
 *   - agent/error            agent 报错
 *
 * 通知通道是包内自带的 notify.ps1（写 JSONL 队列文件 + 独立进程弹气泡），
 * 不走 DSH 的 Web/Electron 通道，因此和 GUI 是否在前台无关。
 *
 * @module dsh-notify
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 包内自带串行队列实现：所有路径都相对本包解析，这个包拷到任何位置、
// 以任何名字安装都能独立运行，不依赖包外任何文件。
import { createNotificationQueue } from './queue.mjs'

/** Loader 行标识。 */
export const name = 'dsh-notify'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NOTIFIER = path.resolve(HERE, '..', 'notify.ps1')

/** 默认配置；字段与 cordis.yml 的 config 一一对应。 */
const DEFAULTS = {
  enabled: true,
  approval: true,
  question: true,
  turnEnd: true,
  error: true,
  sound: true,
  idleMs: 8000,
  /** 两条通知之间的最小间隔；真正的显示节奏由常驻通道掌控，这里只做兜底。 */
  notifyGapMs: 1000,
  queueDir: path.join(os.tmpdir(), 'dsh-notify-queue'),
  /** 测试用：替换真实的通知发送实现。 */
  sender: undefined,
}

const short = (text, max = 110) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/**
 * 按配置发一条通知；任何失败只记录，绝不影响 DSH 本身。
 *
 * Windows 会把几乎同时出现的相邻托盘气泡合并/顶掉（同一应用一次只显示一条），
 * 所以这里串行排队：两条通知之间至少隔 notifyGapMs 才发下一个通知进程。
 */
function makeSender(ctx, config) {
  if (typeof config.sender === 'function') return config.sender
  const logger = () => {
    try {
      return ctx.logger('dsh-notify')
    } catch {
      return { info: () => {}, warn: () => {} }
    }
  }
  let disabled = false

  const notifierLog = path.join(config.queueDir, 'notifier.log')
  const notifierAlive = () => {
    try {
      return Date.now() - fs.statSync(notifierLog).mtimeMs < 20000
    } catch {
      return false
    }
  }

  /** 通道没在跑（或刚因空闲退出）时把它拉起来：一个进程持有一个图标。 */
  const ensureNotifier = () => {
    if (disabled || notifierAlive()) return
    try {
      // Delegate to the package's own start-notifier.ps1: on Windows a Node
      // `detached: true` spawn kills the PowerShell child before it runs
      // anything, while the launcher's Start-Process detaches it properly.
      const launcher = path.resolve(HERE, '..', 'start-notifier.ps1')
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher,
          '-QueueDir', config.queueDir, '-Seconds', '8',
          '-IdleExitSeconds', '1800', '-LogFile', notifierLog,
        ],
        { stdio: 'ignore', windowsHide: true },
      )
      child.on('error', (error) => {
        disabled = true
        logger().warn(`通知通道不可用，已停用：${error.message}`)
      })
      child.unref()
    } catch (error) {
      disabled = true
      logger().warn(`通知通道启动异常：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 交付一条通知：先写临时文件再改名，避免通道读到写了一半的内容。 */
  const deliver = ({ title, body, sound }) => {
    if (disabled) return
    try {
      // 测试钩子：通知被真正交付时回调一次。之所以需要它，是因为队列文件会被
      // 常驻通道立刻消费掉，调用方无法通过"文件还在不在"来判断投递是否发生。
      config.onDeliver?.({ title, body, sound })
      fs.mkdirSync(config.queueDir, { recursive: true })
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const tempPath = path.join(config.queueDir, `.tmp-${stamp}.json`)
      fs.writeFileSync(tempPath, JSON.stringify({ title, body, sound }), 'utf8')
      fs.renameSync(tempPath, path.join(config.queueDir, `item-${stamp}.json`))
      ensureNotifier()
    } catch (error) {
      logger().warn(`通知发送失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const queue = createNotificationQueue({
    deliver,
    gapMs: config.notifyGapMs,
    log: (message) => logger().info?.(message),
  })

  return (title, body, options = {}) => {
    queue.enqueue({ title, body, sound: options.sound ?? config.sound })
  }
}

/** 会话/工作区的一句人类可读描述。 */
function scopeLabel(ctx, agent) {
  const session = agent?.session
  const cwd = session?.header?.cwd ?? session?.cwd
  const workspace = typeof cwd === 'string' && cwd !== '' ? path.basename(cwd.replace(/[\\/]+$/, '')) : undefined
  const title = session?.title
  return short(title ?? workspace ?? agent?.id ?? '未知会话', 40)
}

/**
 * 装载插件。
 * @param ctx - Host context（cordis）。
 * @param config - 插件配置，缺省字段回落到 {@link DEFAULTS}。
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  if (settings.enabled === false) {
    ctx.logger?.('dsh-notify')?.info?.('已禁用，不注册任何监听')
    return
  }
  const send = makeSender(ctx, settings)
  const logger = () => {
    try {
      return ctx.logger('dsh-notify')
    } catch {
      return { info: () => {}, warn: () => {} }
    }
  }

  if (settings.approval) {
    ctx.on('approval/request', (request, next) => {
      try {
        send(
          '⚠ DSH 需要你授权',
          [
            `会话：${scopeLabel(ctx, request.agent)}`,
            `工具：${request.toolName ?? '未知工具'}`,
            short(request.displayReason ?? request.reason ?? '等待你批准这次操作'),
          ].join('\n'),
        )
      } catch (error) {
        logger().warn(`审批通知失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })
  }

  if (settings.question) {
    ctx.on('user-questions/request', (request, next) => {
      try {
        const first = request.questions?.[0]
        send(
          '❓ DSH 在等你回答',
          [first?.question === undefined ? '' : `问：${short(first.question)}`, `会话：${scopeLabel(ctx, request.agent)}`]
            .filter(Boolean)
            .join('\n'),
        )
      } catch (error) {
        logger().warn(`提问通知失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })
  }

  if (settings.turnEnd) {
    // agent/status 的 running→false 只是"这一步跑完了"；等一小段时间仍没有重新运行，
    // 才认为这一轮真的结束，避免每轮都提示。
    const timers = new Map()
    ctx.on('agent/status', ({ agent, status }) => {
      const id = agent?.id
      if (id === undefined) return
      const pending = timers.get(id)
      if (pending !== undefined) {
        clearTimeout(pending)
        timers.delete(id)
      }
      if (status !== 'running' && status !== 'idle') return
      if (status === 'running') return
      const timer = setTimeout(() => {
        timers.delete(id)
        try {
          send('✅ DSH 这一轮任务结束了', [`会话：${scopeLabel(ctx, agent)}`, '可以回去看结果了。'].join('\n'))
        } catch (error) {
          logger().warn(`结束通知失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }, settings.idleMs)
      if (typeof timer.unref === 'function') timer.unref()
      timers.set(id, timer)
    })
    ctx.effect?.(() => () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    })
  }

  if (settings.error) {
    ctx.on('agent/error', ({ agent, error }) => {
      try {
        const message = error instanceof Error ? error.message : String(error ?? '未知错误')
        send('⛔ DSH 执行出错', [`会话：${scopeLabel(ctx, agent)}`, short(message)].join('\n'))
      } catch (inner) {
        logger().warn(`错误通知失败：${inner instanceof Error ? inner.message : String(inner)}`)
      }
    })
  }

  logger().info?.(`已启用：审批=${settings.approval} 提问=${settings.question} 结束=${settings.turnEnd} 错误=${settings.error}`)
}

export default apply
