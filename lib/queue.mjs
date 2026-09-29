/**
 * 串行通知队列。
 *
 * Windows 会把几乎同时出现的相邻托盘气泡合并或顶掉（同一个应用一次只显示一条），
 * 所以通知不能并发投递：入队后一次只交付一条，两条之间至少隔 gapMs。
 * 第一条立即交付，保证"审批请求"这类紧急通知不被排队延迟。
 *
 * @param {object} options
 * @param {(item: {title: string, body: string, sound: boolean}) => void} options.deliver 单条通知的投递实现。
 * @param {number} [options.gapMs] 两条通知之间的最小间隔毫秒。
 * @param {number} [options.maxPending] 队列上限，超出丢弃最旧的。
 * @param {(message: string) => void} [options.log] 可选的进度日志。
 * @returns {{ enqueue: (item: object) => void, size: () => number, dispose: () => void }}
 */
export function createNotificationQueue({ deliver, gapMs = 10000, maxPending = 20, log = () => {} }) {
  const queue = []
  let timer = null
  let lastAt = 0
  let disposed = false

  const pump = () => {
    if (disposed || queue.length === 0) return
    const wait = gapMs - (Date.now() - lastAt)
    if (wait > 0) {
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          pump()
        }, wait)
        if (typeof timer.unref === 'function') timer.unref()
      }
      return
    }
    const item = queue.shift()
    lastAt = Date.now()
    deliver(item)
    if (queue.length > 0) {
      log(`队列还有 ${queue.length} 条，约 ${Math.round(gapMs / 1000)} 秒后弹下一条`)
      pump()
    }
  }

  return {
    enqueue(item) {
      if (disposed) return
      queue.push(item)
      if (queue.length > maxPending) queue.splice(0, queue.length - maxPending)
      pump()
    },
    size: () => queue.length,
    dispose() {
      disposed = true
      queue.length = 0
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
