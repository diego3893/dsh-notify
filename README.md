# dsh-notify

DSH（DeepSeek Harness）桌面端插件：需要你授权、需要你回答、一轮任务结束、执行出错时，
弹出一条 Windows 托盘气泡通知。

## 前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10/11 |
| DSH | 桌面端（Desktop profile），DSH 运行时需自带 Node ≥ 22 与 pnpm |
| 通知设置 | 系统「通知和操作」里允许应用通知；开了「专注助手」时气泡可能不显示 |

## 触发时机

| 事件 | 时机 | 通知 |
|---|---|---|
| `approval/request` | 工具申请提权 / 审批 | ⚠ DSH 需要你授权 |
| `user-questions/request` | 模型调用 `ask_user_question` | ❓ DSH 在等你回答 |
| `agent/status` running→idle | 会话转入空闲（默认静默 8 秒确认） | ✅ DSH 这一轮任务结束了 |
| `agent/error` | agent 报错 | ⛔ DSH 执行出错 |

插件在 `approval/request` 与 `user-questions/request` 上是**旁听者**：先发通知，再 `next()`
把决定权原样交给真正的 answerer（Web 审批面板 / 提问面板），不影响你的选择，也不吞结果。

## 安装

### 推荐：打包安装

**为什么不直接 `pnpm add <目录>`**：那样会写成 `link:` 依赖并在 `node_modules` 里建软链指回
原目录，源目录一旦移动就断链，而且坏链接会让后续 `pnpm add` 直接报错。安装 `.tgz` 则是解包成
**真实副本**，之后搬走或删除 tgz 都不影响运行。

```powershell
# DSH 自带的运行时（路径随安装位置而变，按自己的实际位置替换）
$node  = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar.unpacked\..."  # 或用任意 Node ≥ 22
$pnpm  = "<dsh-runtime>\dependencies\pnpm\bin\pnpm.mjs"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"

# 1) 在仓库根目录打包
cd <本仓库>
& $node $pnpm pack

# 2) 装进桌面端 profile
cd $profile
& $node $pnpm add <本仓库>\dsh-notify-0.1.0.tgz --config.confirmModulesPurge=false

# 3) 让 profile 选中这个 bundle（写回 JSON 时不要带 BOM）
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
if (@($pkg.dsh.profile.bundles) -notcontains 'dsh-notify') {
    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + 'dsh-notify'
    [System.IO.File]::WriteAllText(
        "$profile\package.json",
        ($pkg | ConvertTo-Json -Depth 12) + "`n",
        [System.Text.UTF8Encoding]::new($false))
}
```

装完**重启 DSH**（托盘菜单退出后重新打开）生效。

> 注意：pnpm 按 tarball 路径缓存，覆盖同名 tgz 后可能报 `Already up to date` 而不更新内容。
> 更新版本时用新的文件名（如 `-r2`），或先 `pnpm remove dsh-notify` 再 `add`。

### 也可以用插件管理器

DSH 桌面端侧栏 **插件（Plugins）** 页面 → 安装本地包 → 填 `.tgz` 路径或本仓库目录
（填目录会变成软链）。或让 agent 用 `plugin_manager` 工具的 `install_bundle`，该操作需要
`danger-full-access`，DSH 会先向你申请授权。

## 配置

```yaml
- id: dsh-notify
  name: dsh-notify
  config:
    enabled: true       # 总开关
    approval: true      # 审批请求
    question: true      # 提问请求
    turnEnd: true       # 一轮结束、会话空闲
    error: true         # agent 报错
    sound: true         # 提示音
    idleMs: 8000        # running→idle 后等多久才认为"这一轮结束"
    notifyGapMs: 1000   # 投递到队列的兜底间隔；显示节奏由常驻通道掌控
    queueDir: ''        # 通知队列目录，空 = %TEMP%\dsh-notify-queue
```

> 另有一个仅用于测试的 `onDeliver(item)` 回调：每次通知被真正交付时调用一次。
> 队列文件会被常驻通道立刻消费，所以测试无法通过"文件在不在"判断投递是否发生，
> 这个钩子提供与竞态无关的观测点。生产配置无需关心它。

## 自检

不需要装进 DSH，也不需要 DSH 在运行，就能验证插件逻辑（在本仓库根目录执行）：

```powershell
node test-plugin.mjs         # 假 Context + 注入 sender：断言四类事件与 next() 透传
node test-live.mjs           # 走真实交付链路：断言投递内容（用独立队列目录，不打扰正在跑的通道）
node test-live.mjs --real    # 同上，但写进真实队列目录，会看到右下角真的弹出气泡
```

两个脚本都以退出码 0/1 表示通过或失败，可直接接进 CI。

`test-plugin.mjs` 的期望输出：

```
通过：4 条通知，事件类型全部命中
  - ⚠ DSH 需要你授权 :: ...
  - ❓ DSH 在等你回答 :: ...
  - ✅ DSH 这一轮任务结束了 :: ...
  - ⛔ DSH 执行出错 :: ...
```

## 工作原理（为什么这么实现）

这个包只有一个 Host 入口，但通知链路上有三个必须这么做的决定，都是实测得出的：

1. **常驻通道，而不是每次弹一个进程。**
   `notify.ps1` 是一个长期存活的进程，只建**一个** `NotifyIcon`，按顺序显示队列里的通知。
   一开始是"每条通知起一个 PowerShell 进程各自建图标"，结果 4 条通知都写了 `displayed`、
   屏幕上**只出现 1 条**：Windows 把"同一应用、新进程、新图标"的后续气泡当成屏幕上那条的
   重复而丢弃。复用一个图标实例才能让第 2..n 条真正出现。

2. **`start-notifier.ps1` 用 `Start-Process` 启动通道，而不是从 Node 直接 spawn。**
   在 Windows 上，Node 用 `detached: true` spawn 出来的 PowerShell 子进程会在执行第一条
   语句之前就死掉——没有 `error` 事件、没有 stderr、不写任何文件（实测复现）。

3. **一条通知一个文件（`item-*.json`），而不是追加同一个 JSONL。**
   生产者与读取方就不会争抢同一个文件句柄；先写 `.tmp-*` 再改名，通道也不会读到写了一半的内容。

另外两个环境约束：

- **托盘气泡而不是原生 toast**：PowerShell 进程没有包身份（package identity），调用 WinRT
  `ToastNotificationManager` 一律失败（`0x80073D54`）。`NotifyIcon` 气泡在 Win10/11 上同样以
  通知横幅显示，且不需要包身份。
- **`.ps1` / `.cmd` 一律纯 ASCII**：Windows PowerShell 5.1 会把无 BOM 的 `.ps1` 按 ANSI/GBK 读，
  脚本里的中文会变成语法错误。中文只出现在 Node/JSON 一侧，队列文件由
  `[System.IO.File]::ReadAllLines(..., UTF8)` 显式按 UTF-8 读取。

## 目录

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 入口：注册四类事件监听 |
| `lib/queue.mjs` | 串行投递队列：首条立即、其余按间隔，保证顺序 |
| `notify.ps1` | 常驻通知通道：一个进程、一个托盘图标，顺序显示队列 |
| `start-notifier.ps1` | 幂等启动器：`Start-Process` 把通道脱离控制台启动 |
| `cordis.patch.yml` | bundle 装配条目 |
| `test-plugin.mjs` / `test-live.mjs` | 离线自检 |
| `LICENSE` / `.gitignore` | MIT 许可与仓库忽略规则 |

## 已知限制

- 只在 Windows 上有效（通道是 PowerShell + `NotifyIcon`）。
- 通知由常驻通道串行显示，同一时刻只有一条气泡；`notifyGapMs` 控制投递节奏。
- 通道空闲 30 分钟后自行退出，下次有通知时自动拉起。
- 另有一个**独立监看进程**的实现（不挂 DSH 事件、直接读会话日志），与插件二选一，
  同时启用会重复提示；它作为单独项目维护，不在本仓库内。

## License

MIT
