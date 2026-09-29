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

### 推荐：从 Releases 下载打包好的插件

到 [Releases](https://github.com/diego3893/dsh-notify/releases) 页面下载 `dsh-notify-<版本>.tgz`，
然后：

```powershell
# DSH 自带运行时里的 node / pnpm（按自己的实际安装位置替换）
$node  = "<dsh-runtime>\dependencies\node\bin\node.exe"     # 任意 Node ≥ 22 均可
$pnpm  = "<dsh-runtime>\dependencies\pnpm\bin\pnpm.mjs"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$tgz = "$env:USERPROFILE\Downloads\dsh-notify-0.1.0.tgz"

# 1) 装进桌面端 profile
cd $profile
& $node $pnpm add $tgz --config.confirmModulesPurge=false

# 2) 让 profile 选中这个 bundle（写回 JSON 时不要带 BOM）
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

### 自己打包（想改代码或没有 Release 时）

```powershell
cd <仓库根目录>
& $node $pnpm pack                                  # 生成 dsh-notify-0.1.0.tgz
cd $profile
& $node $pnpm add <仓库根目录>\dsh-notify-0.1.0.tgz --config.confirmModulesPurge=false
# 再执行上面的第 2 步
```

> 注意：pnpm 按 tarball 路径缓存，覆盖同名 tgz 后可能报 `Already up to date` 而不更新内容。
> 换了内容就换文件名（如 `-r2`），或先 `pnpm remove dsh-notify` 再 `add`。

### 为什么用 tgz 而不是目录

`pnpm add <目录>` 会写成 `link:` 依赖，并在 `node_modules` 里建软链指回源目录：源目录一旦
移动或删除，插件立刻断链，而且坏链接会让后续 `pnpm add` 直接报错。安装 `.tgz` 是解包成
**真实副本**，之后把 tgz 删掉也不影响运行。

### 也可以用插件管理器

DSH 桌面端侧栏 **插件（Plugins）** 页面 → 安装本地包 → 填下载好的 `.tgz` 路径（填目录会变成软链）。
或让 agent 用 `plugin_manager` 工具的 `install_bundle`，该操作需要 `danger-full-access`，
DSH 会先向你申请授权。

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

## License

MIT
