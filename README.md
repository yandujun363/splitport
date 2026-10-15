# SplitPort (SRV)

> [!IMPORTANT]
> 本模组为纯粹Agent产物，使用dsh+DeepSeel-V4.1-Flash生成，包括测试案例和这个说明文件和文档，我本人目前只做了基本的进入游戏测试，核心功能的确没问题。能跑。关于测试脚手架，这边会塞到另外一个分支，但我懒得改引用了。反正目前问题不大能跑就行。

**让 Mindustry 客户端按 DNS SRV 记录分别使用 TCP 端口和 UDP 端口** —— 专治经过 NAT 打洞 / 端口映射之后「对外 TCP 端口和对外 UDP 端口不一样」的服务器。

| | |
| --- | --- |
| 模组 ID | `splitport` |
| 显示名 | SplitPort (SRV) |
| 版本 | 2.2 |
| 最低游戏版本 | 146（开发与实测环境：160.7） |
| 平台 | Windows / Linux / macOS / Android；**iOS 不支持**；Steam 联机自动跳过 |
| 类型 | 纯客户端脚本模组（`scripts/main.js`），不添加任何游戏内容 |
| 许可证 | [GPL-3.0-only](LICENSE) |

- **仅客户端**：服务端不用装本模组，也不用改游戏源码，保持原版即可。
- **SRV 优先、原版兜底**：查不到 SRV 记录、或记录里的目标都不应答，就完全回退到原版的单端口逻辑，不会让原本能连的服务器变得连不上。
- **多人游戏兼容**：`mod.hjson` 里 `hidden: true`，模组不会出现在联机握手的模组列表（`Mods.getModStrings()`）里，所以服务端没装也不会把你踢掉。
- **记住路由**：收藏夹里被存成 `IP:TCP端口` 的服务器、掉线重连、游戏重启之后，依然能找回当初的 UDP 端口。

> ⚠️ **已知问题**：只发布 SRV 记录、没有 A/AAAA 记录的域名（"纯 SRV 域名"），在服务器列表里 PING 会显示「无响应」，但**直接进入服务器是正常的**，核心功能（分离 TCP/UDP 端口连接）可用。详见 [已知问题](#已知问题作者实测)。

---

## 解决什么问题

Mindustry 的网络是 TCP + UDP 两条通道，但游戏代码把**同一个端口**填给了两个协议：

```java
// mindustry.net.ArcNetProvider
connectClient : client.connect(5000, ip, port, port);   // TCP 和 UDP 用同一个端口
hostServer    : server.bind(port, port);
```

底层的 Arc 网络库其实**本来就支持两个协议用不同端口**，缺的只是「从哪里知道这两个端口」。服务器经过 NAT / 端口转发 / 云安全组之后，对外的 TCP 端口和 UDP 端口经常不是同一个（NAT1 打洞、家用路由器端口映射、只映射了其中一个协议……），原版客户端这时就永远连不上。

本模组在客户端运行时把 `Vars.net` 的 `NetProvider` 换成 `ArcNetProvider` 的一个子类，只改两件事：

| 阶段 | 原版 | 本模组 |
| --- | --- | --- |
| 服务器列表 ping | 直连 `address:port`（UDP），失败后才查 `_mindustry._tcp` | **先查 SRV**：用 `_udp` 记录的 target:port 发 UDP 发现包，把 `_tcp` 的端口当作 `Host.port` 返回 |
| 连接 | `client.connect(5000, ip, port, port)` | `client.connect(5000, host, tcpPort, udpPort)` |

---

## 安装

把 [splitport.zip](splitport.zip)（或整个模组目录）放进游戏的 `mods` 目录：

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\Mindustry\mods\` |
| Linux | `~/.local/share/Mindustry/mods/` |
| macOS | `~/Library/Application Support/Mindustry/mods/` |
| Android | `/storage/emulated/0/Android/data/io.anuke.mindustry/files/mods/` |

启动后日志里出现下面这行就说明装上了：

```
[SplitPort] installed: 9 packet handler(s) carried over, _mindustry._tcp/_udp split ports active.
```

（数字取决于游戏版本和已装的其他模组：`NetClient` 注册 6 个客户端处理器，`NetServer` 注册 3 个服务端处理器。）

注意事项：

1. **纯客户端模组**：服务端不需要装，装了也不会生效（逻辑只在客户端拦截连接）。
2. **从旧版升级**：如果你装过旧版（模组 ID `split-port-srv`，显示名 "Split Port (SRV)"），请先删掉旧版再装新版，避免两份同时生效。
3. **iOS 不支持**：模组用了 `JavaAdapter` / 反射，`iosCompatible` 保持关闭。
4. **Steam 版自动跳过**：Steam 联机走 SteamNetworkingSockets，没有端口概念，模组会打一行日志后不动网络层。

---

## 服务器端：只要发两条 SRV 记录

在域名上发布 SRV 记录，端口填 **NAT 对外**的端口。例如对外 TCP `25565`、对外 UDP `25566`：

```dns
_mindustry._tcp.example.com.  300 IN SRV 10 10 25565 example.com.
_mindustry._udp.example.com.  300 IN SRV 10 10 25566 example.com.
```

要点：

1. **`_udp` 记录才是本模组的意义所在。** 原版 Mindustry 服务器基本只发 `_tcp`；没有 `_udp` 时模组只能认为 UDP 端口等于 TCP 端口（等同原版行为）。
2. 两条记录的 **target 应指向同一台主机**（同一个域名最省事）。`arc.net.Client.connect(timeout, host, tcpPort, udpPort)` 只接受一个主机地址，TCP 和 UDP 共用；两条 target 不同时模组会在日志里警告，并采用 `_tcp` 的 target。
3. **只发 `_udp`、不发 `_tcp`**：TCP 端口会沿用玩家请求的端口（默认 6567）。想用非默认 TCP 端口，请把 `_tcp` 也发上。
4. 玩家用**域名**加入（服务器列表里填 `example.com`，端口留默认 6567）。手填非默认端口不会触发 SRV，该端口会同时当作 TCP 和 UDP。
5. 纯 SRV 域名（没有 A/AAAA 记录）可以连接，但服务器列表里的 PING 目前有问题，见下一节。

---

## 工作原理

```
玩家在服务器列表里 ping 域名（默认端口 6567）
        │
        ├─ 是域名 且 端口 == 6567 ？ ── 否 ─┐
        │            │是                   │
        │            ▼                     │
        │   查 _mindustry._udp / _tcp       │
        │   （信号量限流 + 无应答重试）       │
        │            │                     │
        │      ┌─────┴──────────────┐      │
        │      │有记录              │没有记录 / DNS 没应答
        │      ▼                    ▼      ▼
        │  按 priority/weight     查"记住的路由"表（本次会话 + 上次启动写入 settings）
        │  ping _udp 记录的                │
        │  target:port（带重试）           │
        │      │                          │
        │      └───────────┬──────────────┘
        │                  ▼
        │      记住 "IP:TCP端口" 和 "域名:TCP端口" -> 连接主机 + 两个端口
        │      把 Host.port 设成 TCP 端口返回给游戏
        ▼
    点击进入 / 直接连接
        │  ① 先查路由表（游戏传进来的是 IP + TCP 端口）
        │  ② 查不到，且是域名 + 默认端口 → 现场查一次 SRV
        │  ③ 都没有 → 原版单端口
        ▼
    client.connect(5000, host, tcpPort, udpPort)
```

任何一步失败（SRV 不应答、target ping 不通、记录格式不对）都会**自动回退到原版逻辑**，不会让游戏连不上原本能连的服务器。

> 注意：如果 DNS **明确回答**「这个域名没有 SRV 记录」，记忆下来的路由不会覆盖它（避免服务器改了端口之后一直用旧路由）；只有「没查到记录、也没有得到明确否定」时才用记忆路由。

---

## 已知问题（作者实测）

> 这一节记录的是**实际测试中确认存在**的问题，不是推测。

### 1. 纯 SRV 域名在服务器列表里 PING 不到（未修复）

**现象**

- 服务器域名只发布 SRV 记录（`_mindustry._tcp` / `_mindustry._udp`），没有 A/AAAA 记录。
- 刷新服务器列表时，该条目显示为**「无响应」**（或一直转圈），看起来像服务器没开。
- 但**直接进入服务器是正常的**：能连上、能正常玩。也就是说分离端口这个核心功能是实现了的。

**影响范围**

- 只是**服务器列表的发现 / PING** 有问题（属于显示与「能不能从列表点进去」的问题），不影响连接本身。
- 有 A 记录的域名不受影响。
- 成功连过一次之后，路由会被记住并写进 `Core.settings`，之后的 PING 可以走记忆路由，该条目就能正常显示了 —— 这是目前可用的临时规避手段。

**根因（基于代码分析）**

`pingHost` 的兜底顺序是：SRV → 记忆路由 → 原版单端口直连。对纯 SRV 域名来说：

1. SRV 查询可能因为解析器丢包、或并发闸门超时而拿不到记录（`srvQuery` 返回 `null`）；此时若还没有记忆路由，就会走到第 3 步。
2. 即使拿到了 `_udp` 记录：探测包（或它的回包）在整表刷新的洪峰里被丢掉，`_udp` 的 target 3 次都没应答时，`pingThroughSrv` 也返回 `null`，同样落到第 3 步。
3. 第 3 步是 `rawPing(address, port)`，内部 `InetAddress.getByName(address)` 对**没有 A 记录的域名**必然抛 `UnknownHostException` → 回调 `invalid` → 列表显示「无响应」。

而「直接进入服务器」走的是 `connectClient` → `resolveRoute`：那里只做**一次不并发的 SRV 查询**，拿到记录后直接用 `_tcp` 的 target/端口和 `_udp` 的端口去连接，所以能成功。

**可能的修复方向**（尚未实现，欢迎 PR）

- `pingThroughSrv` 在 `_udp` 目标不应答时，只要 `_tcp` 有记录，就用 `_tcp` 的 target/端口返回一个可达的 `Host`（UDP 端口仍然用记录里的那个），而不是返回 `null`、让流程落到注定失败的域名直连；
- 对「纯 SRV 域名 + SRV 无应答」的情况，考虑直接用上一次成功解析出来的 `_tcp` target 作为 ping 目标。

**状态**：v2.2 未修复。v2.2 修掉的是同一类现象中的另外两个原因（并发把本机解析器打爆、逐服务器失败日志刷屏），详见 [docs/INTERNALS.md](docs/INTERNALS.md)。

### 2. 测试盲区

- 没有跑过**真正的双客户端多人联机**；`hidden: true` 只做了配置断言 + 源码核对（`Mods.getModStrings()` 过滤 `meta.hidden`）。
- 离线集成测试里没有真正的客户端 UI，`NetClient` 的真实包处理器没有参与，测试用的替代处理器走的是同一条「复制处理器表」代码路径。
- 依赖真实网络的压测（社区列表整表刷新）结果会随网络状况波动，看「解析出错误端口的比例」最稳定。

---

## 限制

- 需要**域名 + SRV 记录**；纯 IP 直连无法自动发现分离端口（DNS 里没有端口信息）。
- `_tcp` 与 `_udp` 的 target 需要能解析到同一台主机。
- 在服务器列表里手填非默认端口不会触发 SRV，按原版单端口处理。
- 记忆路由是「粘性」的：服务器永久换了端口、而旧端口又还有机器应答时，最多会多花一次超时。DNS 明确回答「没有 SRV 记录」时记忆路由不生效。
- 原版客户端无法连接分离端口的服务器 —— 本模组只改客户端，服务端保持原版即可。
- `ArcDns` 自带的 SRV 解析器不校验记录类型、不支持 RDATA 里的名称压缩指针。绝大多数 DNS 符合 RFC 2782（SRV 的 target 不压缩），实测正常；不合规的 DNS 会导致查询失败并回退到单端口。
- 安装时会在旧的 `Net` 之外再建一个 `ArcNetProvider`，旧的那个（一个 selector + 一个 socketChannel）不会被回收。每次启动泄漏一个文件描述符量级，可以忽略。

---

## 排查

日志前缀统一是 `[SplitPort]`：

| 日志 | 含义 |
| --- | --- |
| `installed: N packet handler(s) carried over` | 安装成功，N 应该等于安装前 `Net` 里的处理器数量 |
| `restored N remembered split-port route(s)` | 从上次启动的 settings 里恢复了 N 条分离端口路由 |
| `SRV example.com -> 1.2.3.4 (TCP 25565, UDP 25566)` | SRV 解析成功，接下来用这两个端口 |
| `SRV example.com -> host (single port 25565)` | 只有 `_tcp` 记录，两种协议同端口（等同原版 SRV 回退） |
| `remembered route 1.2.3.4:25565 -> host (TCP 25565, UDP 25566)` | 用之前记住的路由 ping（收藏夹 / 重连 / DNS 临时抽风） |
| `connecting 1.2.3.4 (as given example.com:6567) - TCP 25565 / UDP 25566` | 实际连接目标与两个端口 |
| `no DNS answer for ... after N attempt(s)` | (debug) 解析器完全没应答（不是「没有记录」），会继续走回退逻辑 |
| `SRV UDP target host:25566 did not answer` | (debug) 记录存在但没回应，会继续试下一条记录 → 记忆路由 → 直连 |
| `remembered UDP port ... did not answer, probing normally` | (debug) 记忆的 UDP 端口不通了，改走普通探测 |
| `ping probe for ... failed: ...` | (debug) 探测彻底失败，列表会显示「无响应」（保证回调了一次） |
| `failed to install; the game will keep using the vanilla net provider.` | 安装失败（游戏版本内部结构变化），游戏仍可正常单端口联机 |

> 带 (debug) 的行默认不显示，用 `debug` 启动参数才会出现 —— 原版对 ping 超时本来也不打印，
> 这样刷新几百条社区列表时日志不会被刷屏。

排查思路：

1. 没有 `SRV ... ->` 行 → 域名拼错、`_udp` 记录缺失，或 DNS 不响应。用 `dig SRV _mindustry._udp.example.com` 在本地确认一下。
2. 有 `->` 行但端口不对 → DNS 记录里填的是内网端口，而不是 NAT 对外端口。
3. `connecting ... TCP x / UDP y` 里的目标主机名应该是 SRV 的 target，不是你输入的域名。
4. 列表里偶尔「无响应」是正常的：刷新是几百条一起 ping，原版也会丢一部分。再刷一次即可；纯 SRV 域名请见 [已知问题](#已知问题作者实测)。
5. 用**域名**加入而不是 IP：纯 IP 无法自动发现分离端口（DNS 里没有端口信息）。

---

## 版本

| 版本 | 主要变化 |
| --- | --- |
| 2.0 | 修掉 v1 的两个致命 bug（换 `Net` 时丢包处理器、缺 `hidden: true` 导致被服务端踢），第一次真正能进游戏 |
| 2.1 | 区分「没有 SRV 记录」和「DNS 没有应答」；SRV 查询限流 + 重试；记住路由（收藏夹 / 重连 / 重启） |
| 2.2 | 已知路由时只给 DNS 很短的窗口并改用带上限的 `tryAcquire`，修掉 PING 卡在「刷新中」；逐服务器失败日志降到 `debug`，不再刷屏 |

---

## 开发和测试

模组本体只有两个文件（游戏实际加载的东西），其余是文档和打包产物：

| 文件 | 说明 |
| --- | --- |
| `mod.hjson` | 模组元数据（`hidden: true` 是关键） |
| `scripts/main.js` | 全部逻辑 |
| `README.md` / `docs/INTERNALS.md` | 用户文档 / 内部实现细节 |
| `LICENSE` | GPL-3.0-only |
| `splitport.zip` | 打包好的安装包（`./build.sh` 重新生成） |

开发 / 测试环境不在本仓库里，在 `../splitport-mod-dev/`（见那里的 `README.md`）。
它会用官方发布包里的**真实 Arc / Rhino / 游戏类**加载**真正的 `scripts/main.js`**，跑离线集成测试：

```bash
cd ../splitport-mod-dev/test
javac -nowarn -cp ../refs/server-release.jar -d out *.java
java -cp out:../refs/server-release.jar SplitPortHarness \
     ../refs/x/scripts/global.js \
     ../../splitport-mod/scripts/main.js \
     ../../splitport-mod/mod.hjson
```

退出码 0 = 全部通过（9 个场景）。想改这个模组，请**先读 [docs/INTERNALS.md](docs/INTERNALS.md)**：
里面写了 Rhino / 并发的坑（正则、循环里的 `const`、`Seq.get`、反射……），全是踩过的。

---

## 许可证

**GPL-3.0-only**（与上游 Mindustry 一致），完整文本见 [LICENSE](LICENSE)。

为什么不能是 MIT / Apache-2.0 这类宽松许可证：

- 上游 Mindustry 是 **GPL-3.0**（`github/Mindustry/LICENSE`），且**没有任何 linking / modding 例外条款**。
- 本模组不是「隔着一层命令行调用的独立程序」，而是在运行时与 Mindustry 紧密结合：
  - 通过 `JavaAdapter` / `extend()` 生成 `mindustry.net.ArcNetProvider`（GPL-3.0 的类）的**子类**；
  - 构造 `mindustry.net.Net`，并**反射读取它的私有字段** `clientListeners` / `serverListeners`；
  - 依赖 `Vars`、`Core`、`NetworkIO`、`ArcDns` 等运行时内部接口。
- 这种亲密程度下，模组代码与 Mindustry 构成**结合作品 / 衍生作品**，必须整体按 GPL-3.0 分发。因此 MIT 与上游**不兼容**，按「与上游一致」处理。
- 模组**没有复制任何上游源码**（全部是独立实现），这不是问题所在；问题在于运行时链接关系。
- 唯一另一个上游依赖是 Arc，**Apache-2.0**，属于宽松许可证，与本模组不冲突，也不改变上面的结论。

> 如果将来希望改成 MIT，需要 Mindustry 作者给出 modding 例外，或者把实现改成完全不依赖 Mindustry 内部结构（对本模组的设计而言不现实）。

上游项目：[Mindustry](https://github.com/Anuken/Mindustry)（GPL-3.0）、[Arc](https://github.com/Anuken/Arc)（Apache-2.0），作者 Anuken 及贡献者。本模组与上游项目没有隶属关系。

---

## English summary

**SplitPort (SRV)** is a client-side-only Mindustry mod. Mindustry connects with TCP and UDP on the same
port (`client.connect(5000, ip, port, port)`), even though Arc supports separate ports. Behind NAT the
external TCP and UDP ports are often different, so the vanilla client cannot join such servers.

This mod replaces the net provider on the client and:

- resolves `_mindustry._tcp.<host>` and `_mindustry._udp.<host>` SRV records and uses the two ports
  separately (`client.connect(5000, host, tcpPort, udpPort)`);
- UDP-pings the `_udp` target for server discovery and reports the TCP port to the game;
- falls back to vanilla single-port behaviour whenever no SRV record answers, so nothing that used to
  work stops working;
- is marked `hidden: true`, so it is not part of the multiplayer mod handshake and servers without it
  never kick you;
- remembers learned routes across restarts (favourites stored as `IP:TCPport`, reconnects).

**Known issue:** for hosts that publish *only* SRV records (no A/AAAA record), the server-list PING
shows the entry as "not responding"; joining such a server directly still works, so the core feature is
functional. See the Chinese "已知问题" section above for the root cause and suggested fixes.

Licensed under **GPL-3.0-only**, matching upstream Mindustry (the mod links against GPL-3.0 classes at
runtime, so a permissive licence such as MIT is not compatible).
