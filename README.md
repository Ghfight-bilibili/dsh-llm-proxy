# DSH LLM Proxy

给 **DSH 进程自己** 使用的 Clash / Mihomo 代理插件：

- 导入 Clash / Mihomo 订阅链接（http(s)、本地 YAML，兼容 base64 包装的 YAML）；
- DSH 自动按延迟选择节点，定期重新测速并切换；
- 也可以手动指定节点，或一键恢复自动选择；
- 不修改 Windows 系统代理，不开 TUN，不影响浏览器、游戏、下载器等其它程序；
- 只把 DSH 主进程发出的网络请求接到本机回环地址上的私有 Mihomo 实例；
- 自带 Web 控制面板，可直接导入订阅、查看状态、自动/手动选择节点；
- 支持“全部流量 / 仅模型接口”两种代理范围，以及按域名绕行，默认绕开 DSH Remote 等控制面。

> 已在 Windows x64 + DSH 0.2.2-rc.1 上完成端到端验证。其它平台有对应的 Mihomo 核心映射，但未逐一实测。

## 工作原理

插件在 DSH 数据目录（默认 `%USERPROFILE%\.dsh\clash-proxy`）下启动一个独立的 Mihomo 子进程：

```text
DSH 主进程 fetch
      │
      ▼
127.0.0.1:<随机混合端口>  ← 只监听回环地址
      │
      ▼
Mihomo（私有配置、私有数据目录）
      │
      ├─ DSH-AUTO：url-test 自动测速组
      └─ DSH：select 组，默认指向 DSH-AUTO，也可手动选节点
```

- Mihomo 配置只包含订阅里的 `proxies`、`DSH-AUTO`、`DSH` 和 `MATCH,DSH` 规则；
- `allow-lan: false`，不监听局域网；`dns.enable: false`；不设置系统代理、不创建 TUN 网卡；
- 外部控制端口使用随机端口 + 随机 secret，仅绑定 `127.0.0.1`；
- 插件替换 DSH 主进程的 `globalThis.fetch`：回环地址和私有网段直接走原 fetch，其它地址走本机 Mihomo 的混合端口；
- 节点切换发生在 Mihomo 内部，因此切换节点不需要重装 dispatcher，也不会断开 DSH 的其它连接。

## 环境要求

- DSH `0.2.2-rc.1` 或兼容版本（插件清单版本 1）；
- Node.js `>= 20`；
- 订阅必须是 **包含内联 `proxies` 列表的 Clash / Mihomo YAML**；
  - 支持直接返回 YAML，也支持整段 base64 包装的 YAML；
  - 只返回 `proxy-providers`、没有内联 `proxies` 的订阅暂不支持，请换一个返回完整配置的订阅链接。

## 安装

### 方式 A：安装 Release 中的 tarball（推荐，立即可用）

1. 从 [Releases](https://github.com/Ghfight-bilibili/dsh-llm-proxy/releases) 下载
   `dsh-llm-proxy-plugin-0.4.2.tgz`；
2. 在下载目录执行：

```bat
dsh plugin --profile desktop add .\dsh-llm-proxy-plugin-0.4.2.tgz --config.auto-install-peers=false
```

然后把下面这段加到当前 profile 的用户 patch 文件
`C:\Users\<用户名>\.dsh\profiles\desktop\cordis.patch.yml` 末尾：

```yaml
- insert:
    - id: dsh-llm-proxy
      name: "dsh-llm-proxy-plugin"
      config:
        autoStart: true
```

> 插件自己的 `cordis.patch.yml` 也会插入同名条目。**不要同时**把
> `dsh-llm-proxy-plugin` 加进 `dsh.profile.bundles` 再手写 patch，否则可能重复加载。
> 二选一：用上面的手写 patch，或把包名加入 `dsh.profile.bundles` 让插件自带 patch 生效。

### 方式 B：从 npm 安装

```bat
dsh plugin --profile desktop add dsh-llm-proxy-plugin --config.auto-install-peers=false
```

> npm 对首次发布的新包会先创建 `0.0.0-stage` 占位版本并进入审核。若
> `npm view dsh-llm-proxy-plugin version` 返回 `0.0.0-stage`，说明审核尚未完成，请使用方式 A。

### 方式 C：从源码打包

```bat
git clone https://github.com/Ghfight-bilibili/dsh-llm-proxy.git
cd dsh-llm-proxy
npm pack
dsh plugin --profile desktop add .\dsh-llm-proxy-plugin-0.4.2.tgz --config.auto-install-peers=false
```

然后按方式 A 的 YAML 增加 patch 条目。

安装完成后重启 DSH。重启后在会话里应该能看到 `clash_*` 工具。

## Web 控制面板

插件自带一个控制面板，不用记工具名也能操作：

- 在 DSH 的 **设置 → DSH LLM Proxy** 中直接打开；
- 或浏览器访问 `http://127.0.0.1:<DSH Web 端口>/clash-proxy`（端口以你的 DSH Web 地址为准）。

面板支持：

- 粘贴订阅链接并一键导入、启动；
- 查看运行状态、当前出口节点、端口和核心版本；
- 自动选择 / 手动切换节点，按延迟排序和搜索；
- 测速、更新订阅、安装/修复核心、启动/停止代理；
- “绕过与范围”选项卡：切换“全部流量 / 仅模型接口”，编辑按域名绕行列表，保存后立即生效。
- “打开完整页面”点击后立即在 DSH 内显示全屏面板，同时由 host 调用系统默认浏览器；即使浏览器被挡在后面，DSH 内也能直接操作。

面板里的所有操作都只作用于 DSH，不会修改系统代理或其它程序。

## 配置

在 profile patch 的 `config` 中配置，全部字段都可省略：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `autoStart` | `true` | DSH 启动时，如果已有订阅和核心，就自动启动代理 |
| `subscriptionUrl` | `''` | 首次启动自动导入的订阅链接；为空则等待手动 `clash_subscribe` |
| `corePath` | `''` | 自定义 `mihomo` 可执行文件路径；为空则使用数据目录下自动安装的核心 |
| `testUrl` | `https://www.gstatic.com/generate_204` | 自动测速 URL |
| `testInterval` | `300` | 自动测速间隔，秒，范围 30–3600 |
| `mixedPort` | `0` | 混合代理端口；`0` 表示自动选择空闲端口 |
| `dataDir` | `''` | 数据目录；为空使用 `$DSH_HOME/clash-proxy` 或 `%USERPROFILE%\.dsh\clash-proxy` |
| `downloadCore` | `true` | 核心缺失时是否自动从 npm 下载匹配平台的 Mihomo |
| `proxyScope` | `all` | 代理范围：`all` 全部外部请求；`models` 仅大模型 API，其余直连 |
| `bypassHosts` | 默认控制面列表 | 额外绕行域名，逗号或换行分隔；支持 `*`、`*.example.com`；留空则使用默认值 |

示例：

```yaml
- insert:
    - id: dsh-llm-proxy
      name: "dsh-llm-proxy-plugin"
      config:
        autoStart: true
        subscriptionUrl: 'https://example.com/api/v1/client/subscribe?token=...'
        testInterval: 300
        testUrl: 'https://www.gstatic.com/generate_204'
        mixedPort: 0
        downloadCore: true
        proxyScope: all
        bypassHosts: 'dsh.r2049.cn,*.r2049.cn,*.ts.net'
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `clash_subscribe` | 导入订阅并立即启动；参数 `url`（必填，http(s) 或本地 YAML 路径）、`name`（可选显示名） |
| `clash_status` | 查看运行状态、当前节点、模式、端口、订阅、核心版本、最近错误 |
| `clash_nodes` | 列出节点和延迟；`test=true` 时立即测速，`limit` 默认 12、最大 50 |
| `clash_select` | 手动指定节点；`name` 传节点名或 `auto` |
| `clash_auto` | 恢复自动选择（DSH-AUTO） |
| `clash_test` | 测试节点延迟；可用 `names` 指定节点，或不传 `names` 测前 `limit` 个 |
| `clash_update` | 重新拉取当前订阅并热重启；手动节点仍存在时会保留 |
| `clash_start` | 用已保存的订阅启动 |
| `clash_stop` | 停止核心并恢复 DSH 直连 |
| `clash_install_core` | 下载 / 修复当前平台的 Mihomo 核心 |

## 典型使用

首次使用：

1. 对 DSH 说「导入这个 Clash 订阅：https://...」；
2. DSH 调用 `clash_subscribe`，自动下载核心（若缺失）、解析节点、启动 Mihomo；
3. 用 `clash_status` 确认 `running: true`、`mode: auto`；
4. 用 `clash_nodes` 查看节点和延迟。

手动换节点：

- 「用香港 01 节点」→ `clash_select({ name: '香港 01' })`；
- 「恢复自动选节点」→ `clash_auto()`。

更新订阅：

- `clash_update()`。如果之前手动选的节点在新订阅里仍然存在，会继续保留；否则自动回到 `DSH-AUTO`。

临时直连：

- `clash_stop()`。DSH 立即恢复原 fetch；其它程序全程不受影响。

## 数据目录

默认 `%USERPROFILE%\.dsh\clash-proxy\`（设置了 `DSH_HOME` 时为 `$DSH_HOME/clash-proxy`）：

```text
clash-proxy/
  state.json          # 运行状态、订阅信息、当前选择
  config.yaml         # 每次启动生成的 Mihomo 配置
  subscription.yaml   # 最近一次原始订阅
  proxies.json        # 解析后的节点
  bin/mihomo.exe      # 自动下载的核心
```

订阅和节点文件以 `0600` 权限写入（Windows 上由 ACL 体现）。

## 自动调度细节

- `DSH-AUTO` 是 Mihomo 的 `url-test` 组：
  - `url` 为配置的 `testUrl`；
  - 每 `testInterval` 秒测试全部节点；
  - `tolerance: 50`，延迟差距在 50ms 内不频繁切换；
  - `lazy: false`，即使没有流量也会定期测速。
- `DSH` 是 `select` 组，默认选中 `DSH-AUTO`；
- 手动选择写入 `state.json`，并通过 Mihomo 的 `profile.store-selected` 持久化；
- 代理入口始终是固定的本机混合端口，节点切换不会改变 DSH 的 fetch 配置。

## 不影响其它程序

- 不调用 Windows「Internet 选项」、不写系统代理注册表；
- 不启用 TUN / 虚拟网卡；
- Mihomo 只监听 `127.0.0.1`，`allow-lan: false`；
- 只替换 **DSH 主进程** 的 `globalThis.fetch`；其它进程完全不知道这个代理存在；
- 回环地址、`localhost`、私有网段（10/8、172.16/12、192.168/16、169.254/16、100.64/10）直接走原 fetch，避免影响本机服务、局域网模型和 DSH 自己的控制面；
- 默认绕行 `dsh.r2049.cn`、`*.r2049.cn`、`*.ts.net`、`*.local`、`*.lan`，以及 `deepseek.com`、`*.deepseek.com`、`deepseek.ai`、`*.deepseek.ai`、`deepseek-ai.github.io`。DSH Remote 的信令服务器 `https://dsh.r2049.cn` 因此始终直连；
- 也可以在面板里改用“仅模型接口”，只让大模型 API 走代理，Remote、插件市场和其它网络请求全部直连。

## 已知限制

- 只覆盖 DSH 主进程的 `globalThis.fetch`。Node `worker_threads`、`node:https`、WebSocket、Electron `net` 等不会自动经过代理；当前 DSH 的 LLM 请求使用 `fetch`，主链路已覆盖。
- 如果另一个插件在 DSH 启动后再次替换 `globalThis.fetch`，可能绕过本插件；卸载/停用本插件时会恢复原 fetch。
- 只支持内联 `proxies` 的订阅；`proxy-providers` 需要先由服务商展开。
- 需要 DSH 进程有启动子进程的权限。若出现 `spawn ... EPERM`，检查 DSH 是否运行在禁止子进程的沙箱中。
- Mihomo 核心从 npm 的 `@pkgship/mihomo-*` 包下载；首次安装需要能访问 npm registry。
- 订阅节点本身的协议支持范围由 Mihomo 决定。

## 卸载

1. 在 profile patch 中删除 `id: dsh-llm-proxy` 的 `insert` 条目；
2. 如果通过 pnpm 安装：

   ```bat
   dsh plugin --profile desktop remove dsh-llm-proxy-plugin
   ```

3. 删除数据目录 `%USERPROFILE%\.dsh\clash-proxy`（可选，会同时删除已下载核心和订阅缓存）；
4. 重启 DSH。

## 许可证

MIT，见 [LICENSE](LICENSE)。
