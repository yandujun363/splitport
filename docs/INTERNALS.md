# SplitPort (SRV) — 内部实现与开发笔记

面向要改这个模组的人。用户文档在 [../README.md](../README.md)。

- 模组 ID：`splitport`，版本 2.2，许可证 GPL-3.0-only。
- 本体是一个 Rhino 脚本模组：`../scripts/main.js`（约 930 行）+ `../mod.hjson`。
- 测试环境在 `../../splitport-mod-dev/`（不在本仓库内）。

---

## 1. 安装点：为什么要「搬」包处理器

模组在 `ClientLoadEvent` 里执行 `install()`：

1. 反射找到 `mindustry.net.ArcNetProvider` 的私有字段 `client`（`locateClientField()`）；
2. `buildProvider()` 用 `extend(ArcNetProvider, {...})` 造一个新的 provider，只覆盖
   `pingHost` 和 `connectClient`；
3. `new Net(provider)` 造一个新的 `Net`；
4. `copyListeners(original, replacement)` 把旧 `Net` 的私有 `clientListeners` /
   `serverListeners` 两张表**读出来**，通过公开 API `handleClient` / `handleServer` 重新注册；
5. `Vars.net = replacement`。

`NetClient` / `NetServer` 在**构造时**就把自己所有的包处理器注册到当时那个 `Net` 实例上：

```java
// mindustry.core.NetClient 构造函数
net.handleClient(Connect.class, ...);
net.handleClient(Disconnect.class, ...);
net.handleClient(WorldStream.class, ...);
net.handleClient(StreamBegin.class, ...);
// mindustry.core.NetServer 构造函数同理
```

而它们的构造发生在 `ClientLauncher.init()` 里，**早于**模组脚本执行（脚本在资源加载阶段才跑）。
所以如果直接 `Vars.net = new Net(provider)`，新 `Net` 的处理器表是空的：

- 客户端收不到 `Connect` → 不会发 `ConnectPacket`；
- 收不到 `WorldStream` → 永远卡在 "Connecting"。

端口确实换掉了，但握手根本走不下去。这就是 v1「端口换了却进不去游戏」的原因。

v2 的做法是**只读私有字段、不修改任何 final 字段**，因此在 Java 9+ 的强封装和未来 JDK 上都能用
（用反射改写 `final` 字段在 JDK 27 已经会打印弃用警告，将来会被禁用）。

## 2. 为什么必须有 `hidden: true`

服务端在 `NetServer` 里校验客户端的模组列表：

```java
Seq<String> extraMods = packet.mods.copy();
Seq<String> missingMods = mods.getIncompatibility(extraMods);
if(missingMods.size > 0 || extraMods.size > 0){ con.kick("Incompatible mods!", 0); }
```

而客户端的列表来自 `Mods.getModStrings()`：

```java
return mods.select(l -> !l.meta.hidden && l.enabled()).map(...);
```

也就是说，**只有 `hidden: true` 的模组才会被排除在这个列表之外**。脚本模组不会被自动当成
`Plugin`（`Mods.java` 里只对 `mainMod instanceof Plugin` 隐式设 `hidden`），所以必须手写在
`mod.hjson` 里。漏了这一行，服务端就会看到多余的模组并直接踢人。

`hidden: true` 同时意味着「这个模组不添加任何内容」—— 本模组确实不加。

## 3. PING 洪峰：为什么刷新服务器列表时探测会失效

`JoinDialog.refreshRemote()` / 社区列表会对**全部条目同时**发起 ping：

```java
// core/src/mindustry/ui/dialogs/JoinDialog.java
net.pingHost(resaddress, resport, res -> { ... }, e -> { ... });   // 每条一次，全部并发
```

官方社区列表 v8 有 266 条，其中 123 条是域名 → 模组会发出约 246 次 SRV 查询。
对纯 SRV 域名（没有 A 记录，原版直接抛 `UnknownHostException`）重复刷新，实测：

每次"刷新"= 266 条社区条目同时 ping + 该服务器 **6 条**（收藏夹 / 社区列表 / 最近列表等），
共刷新 10 轮，合计 60 次 ping，对真实服务器实测：

| 版本 | 正确解析出 TCP 23608 / UDP 23467 | 解析出**错误**端口（TCP=6567） | 完全失败（列表显示"无响应"） |
| --- | --- | --- | --- |
| v2.0 | 35 / 60 | **9 / 60** | **16 / 60** |
| v2.1 | **60 / 60** | **0** | **0** |

也就是 v2.0 有 **42%** 的刷新是坏的（要么显示成错误的端口、点了连不上；要么直接"无响应"）。
把同一个服务器并发 ping 40 次（极端情况）时，v2.0 的结果是 **3 正确 / 7 端口错误 / 30 失败**。

### 3.1 原因一（主因）：并发把本机 DNS 打爆，而 `ArcDns` 把"查询失败"和"没有记录"混为一谈

`ArcDns.getSrvRecords(domain)` 会**吞掉所有 IOException** 然后返回一个**空列表**：

```java
public static Seq<SRVRecord> getSrvRecords(String domain){
    for(InetSocketAddress nameserver : nameservers){
        try{ return getSrvRecords(domain, nameserver); }
        catch(IOException ignored){}          // 超时/丢包/应答损坏 → 当作没记录
    }
    return new Seq<>(1);                       // ← 和"这个域名确实没有 SRV"完全一样
}
```

本机 resolver 在并发稍高时就会丢 UDP 应答。实测（同一条确实存在的记录，400 次查询）：

| 同时在飞的 SRV 查询数 | 1 | 4 | 8 | 16 | 64 | 400 |
| --- | --- | --- | --- | --- | --- | --- |
| 拿不到记录的比例 | 0% | 0% | **0%** | 0.75% | **41%** | 29% |

于是绝大多数 SRV 查询"查不到记录" → 模组回退到原版单端口 ping → 对于纯 SRV 域名
（没有 A 记录）这个 ping 必然失败 → 列表显示"无响应"。
而点进去能连上，是因为**连接只做一次 SRV 查询、没有并发**，那一次是成功的。

### 3.2 原因二：UDP 探测包在刷新洪峰里被丢

即使 SRV 查到了，向 `_udp` 的 target:port 发的那一个发现包（或者它的回包）在 266 个并发 ping
的洪峰里也会被客户端路由器的 NAT 表丢掉。原版同样会丢（官方列表 266 条里有 144 条 ping 失败），
所以这一条只能靠重试缓解。

### 3.3 v2.1 的修复

1. **区分"没有记录"和"没有应答"**：不再用 `getSrvRecords(domain)`，改成自己遍历
   `ArcDns.getNameservers()` 调**会抛异常**的 `getSrvRecords(domain, nameserver)`。
   抛异常 = 这次查询没结果（可以重试）；正常返回空列表 = 这个域名真的没有该记录。
2. **限制并发**：用一个公平信号量把同时在飞的 SRV 查询限制在 8 个（实测 0% 丢包），
   并对"没有应答"的查询重试最多 3 次。
3. **`_udp` 有记录但 `_tcp` 查空时再确认一次**：一个发了 `_udp` 的服务器几乎一定也发
   `_tcp`，只空一边的答案不可信。这修掉了"TCP 端口被当成玩家输入端口"的错误结果。
4. **SRV 目标的 UDP 探测重试**：第 2、3 次分别在 250ms 和 1500ms 后重发，避开刷新洪峰。
   只对 SRV 目标重试，普通直连 ping 的耗时和原版完全一致。
5. **任何异常都不许逃出 `pingHost`**：`Net.pingHost` 把任务丢进线程池
   （`pingExecutor.submit(...)`），异常会被无声吞掉、条目就会永远转圈；现在最外层兜底，
   保证 `valid` / `invalid` 一定被调用一次。

### 3.4 顺带修掉的另一个 ping 问题：收藏夹 / 重连的 ping

`JoinDialog` 把"从社区列表加收藏"存成 **`<解析出的IP>:<TCP端口>`**：

```java
// JoinDialog.addCommunityHost
server.setIP(host.address + ":" + host.port);
```

之后刷新这个收藏（`refreshServer`）和掉线重连（`reconnect()`）都会拿 `IP:TCP端口` 去 ping。
IP 没法查 SRV，UDP 端口也早就丢了 —— 于是收藏条目永远"无响应"，重连也永远等不到。

模组会记住每次 SRV 解析出来的路由（`IP:TCP端口 -> 连接主机 + 两个端口`），ping 的时候先查这张表；
并且**写进 `Core.settings`（键 `splitport-routes`，最多 128 条）**，所以重启游戏之后收藏夹依然能正常刷新。

### 3.5 v2.2：PING 卡在"刷新中"的根因，以及日志不再刷屏

v2.1 之后仍有反馈：**自己那台分离端口的服务器在列表里 PING 一直转圈**，但直接点进去能正常玩；
日志里能看到 `restored N remembered split-port route(s)`，说明路由记得，却没被用上。

原因有两个：

1. **ping 必须先过 SRV 闸门，才轮到"记忆路由"。** v2.1 的顺序是"先 SRV、后记忆路由"，
   而社区列表刷新时约 246 次 SRV 查询把 8 个闸门许可占满；收藏夹那次 ping 排在队尾。
   更糟的是"没有应答"的查询每次要耗掉最多 3 个 nameserver × 2s × 3 次重试 ≈ 18s 才释放许可，
   于是一条 ping 要等好几分钟甚至永远等不到，界面就一直是"刷新中"。
2. **日志刷屏。** v2.1 的 `pingHost` 兜底 `catch` 对**每个**不响应的服务器都 `Log.err` 一行。
   官方列表 266 条里大部分不响应，一次刷新就是几百行 `[SplitPort] ping probe ... failed`，
   把控制台/日志里的聊天、进出服务器消息全冲掉。**原版对超时是完全不打印的。**

v2.2 的修复：

1. **已知路由时只给 DNS 一个很短的窗口。** 已有记忆路由的地址只给 SRV 查询
   `SRV_GATE_WAIT_KNOWN_MS = 300ms`（拿不到闸门就直接用记忆路由）；没有路由的地址才用完整的
   `SRV_GATE_WAIT_MS = 2500ms`。DNS 来得及纠正就用权威结果，来不及就立刻走记忆路由。
2. **闸门改成带上限的 `tryAcquire`**，永远不再无限排队。等不到就当作"这次查询没应答"，
   继续走记忆路由 / 原版单端口，`valid` / `invalid` 必定回调一次。
3. **`_udp` 查空时也重试一次**（v2.1 只做了 `_tcp` 查空的重试）。分离端口服务器最怕的就是
   `_udp` 那次丢包：那会把模组推进"拿 `_tcp` 端口发 UDP"的原版回退，而那个端口根本不响应 UDP。
4. **逐服务器的失败日志降到 `Log.debug`**（见第 6 节）。安装、解析成功、连接这些关键行仍是 `info`。

实测（真实服务器 + 官方 266 条社区列表同时刷新）：

| 场景 | v2.1 | v2.2 |
| --- | --- | --- |
| 收藏夹（已记住路由）在 266 条洪峰中 ping | 一直"刷新中"（排在闸门队尾） | **623ms，端口正确** |
| 整表刷新时的 `[SplitPort] ping probe` 错误行 | 几百行 | **0 行** |
| 无路由的纯 SRV 域名整表刷新（0% 丢包） | 13.8s | 8.6s |

## 4. 仍未修复：纯 SRV 域名的列表 PING

用户实测确认（README「已知问题」）：**只发布 SRV 记录、没有 A/AAAA 记录的域名**，在服务器列表
里会显示"无响应"，但直接进服务器是正常的。

`pingHost` 的第 3 步兜底是原版逻辑：

```js
const host = rawPing(address, port);   // 内部 InetAddress.getByName(address)
```

对纯 SRV 域名，`InetAddress.getByName()` 必然抛 `UnknownHostException`，所以这一层兜底**永远
不可能成功**；也就是说纯 SRV 域名的 ping 完全依赖第 1 步（`pingThroughSrv` 里 `_udp` target 的
UDP 发现包恰好成功）或第 2 步（已经记住的路由）。当 SRV 查询拿不到记录 / 闸门超时 / `_udp`
探测三次都不应答时，条目就只能显示"无响应"。

`pingThroughSrv` 目前还有一个可以商量的行为：`_udp` target 全部不应答时它返回 `null`，
哪怕 `_tcp` 记录明确存在。改成"`_tcp` 有记录就返回一个可达的 `Host`（UDP 端口仍用记录里的值）"
应该就能让这类条目正常显示并可以点进去。注意这样做的语义变化：ping 的结果不再代表"UDP 发现
包通了"，而只是"DNS 里有这台服务器的记录"。做之前请先补上对应的测试场景。

## 5. Rhino / 并发的坑（改动时请遵守）

这是纯 JS（script）模组，跑在 Mindustry 内置的 Rhino 上，以下每一条都是**踩过的**：

1. **绝对不要用正则表达式。**
   Rhino 的 `NativeRegExp` 会缓存编译后的字节码，在非主线程（ping 线程池、连接线程）执行时会抛
   `FAILED ASSERTION: invalid bytecode`。`isIpAddress` / `stripDot` 全部用普通字符串操作实现。
2. **循环体里绝对不要用 `const` 声明局部变量。**
   实测（Mindustry v160.7 自带 Rhino，优化级别 9）：

   ```js
   for(let i = 0; i < a.length; i++){ const k = a[i]; out += k; }  // => "aa"，永远取第 0 个
   for(let i = 0; i < a.length; i++){ let   k = a[i]; out += k; }  // => "ab"，正确
   ```

   优化器把 `const` 当常量折叠掉了。循环体内一律用 `let`。
3. **`Seq.get(int)` 不要用在 Rhino 编译出来的循环里**，同样会一直返回第 0 个元素；用 `toArray()`
   再下标（并且配合第 2 条用 `let`）。
4. **通过 `importPackage` 拿到的 Java 类不能直接调 `java.lang.Class` 自己的方法**：
   `ArcNetProvider.getDeclaredField(...)` 会报 "has no public instance field or method named ..."。
   先用 `java.lang.Class.forName("mindustry.net.ArcNetProvider")` 拿到真正的 `Class` 再反射。
5. **不要往 Java 容器里塞 JS 对象再跨线程读**。路由表用的是
   `ConcurrentHashMap<String, String>`，键和值都用 `new java.lang.String(...)` 强制成真正的 Java
   字符串（否则 `equals`/`hashCode` 行为不可靠）。
6. **Arc 的 `ObjectMap` 迭代器包装类是包级私有的**，不能直接 `while(it.hasNext())`；用
   `map.keys().toSeq().toArray()` 再遍历。
7. **`JoinDialog` 会一次 ping 几百个服务器**，任何"每次 ping 都要做一次网络往返"的设计都必须限流，
   否则本机 resolver 会丢应答（见 §3.1）。

## 6. 日志级别策略

| 级别 | 内容 |
| --- | --- |
| `info` | 安装成功、恢复路由、SRV 解析结果、记忆路由命中、实际连接目标 |
| `debug` | 逐服务器的失败（DNS 无应答、SRV target 不应答、ping 探测失败）、记忆 UDP 端口不通 |
| `warn` | 配置类问题（记录 target 是 no-service、`_tcp`/`_udp` target 不一致、路由写不进去） |
| `err` | 安装失败、连接失败（且此时不是在连接中） |

原则：**默认级别下每个服务器最多 0 行**。原版对 ping 超时不打印任何东西，模组也不打印。

## 7. 测试

`../../splitport-mod-dev/` 里有可复现的测试环境。核心是用官方发布包里的
**真实 Arc / Rhino / 游戏类**加载**真正的 `main.js`**：

```bash
cd ../../splitport-mod-dev/test
javac -nowarn -cp ../refs/server-release.jar -d out *.java
java -cp out:../refs/server-release.jar SplitPortHarness \
     ../refs/x/scripts/global.js \
     ../../splitport-mod/scripts/main.js \
     ../../splitport-mod/mod.hjson
```

| 测试 | 内容 |
| --- | --- |
| `test/SplitPortHarness.java` | 离线集成测试：本地转发器扮演 NAT（服务器内部仍是单端口，对外是 12565/TCP + 12566/UDP），本地 DNS 服务器发布 SRV，跑完 9 个场景 |
| `test/SrvGate.java` | 复现 DNS 并发丢包：400 次查询在 1/4/8/16/64/400 并发下的丢失率 |
| `test/SrvStress.java` | 用真实社区列表按 `JoinDialog` 的方式整表刷新，检查目标服务器每次都能解析出正确的两个端口 |
| `test/LivePing.java` | 对真实服务器跑"ping 域名 → 收藏成 ip:端口 → 再 ping 收藏"的完整链路 |
| `test/ConcurrentPing.java` | 266 条社区条目并发 ping，检查每一个都恰好回调一次 |

`SplitPortHarness` 覆盖的场景（全部 PASS）：

1. 安装：`Vars.net` 被替换、客户端/服务端包处理器数量与安装前一致、`mod.hjson` 里 `hidden: true`；
2. `_tcp` + `_udp` 分离端口，并像 `JoinDialog` 那样用 **ping 出来的数字 IP + TCP 端口**去连接；
3. 没有 SRV → 完全走原版单端口；
4. 只有 `_udp` → UDP 用 SRV 端口，TCP 用请求的端口；
5. 只有 `_tcp` → 等同原版 SRV 回退；
6. 第一条 `_udp` 记录不可达 → 自动用第二条；
7. 收藏夹形式（`ip:tcpPort`）的重复 ping；
8. 模拟重启（全新的 Rhino 作用域 + 空的路由表）后，只靠 settings 里的记忆路由 ping 通；
9. 自己开服（`Vars.net.host`）时 TCP/UDP 两个端口都正常绑定。

改动 `main.js` 后请至少跑一遍 `SplitPortHarness`；改到 ping 逻辑时再跑 `SrvStress` / `LivePing`
（需要真实网络，参数见 `../../splitport-mod-dev/README.md`）。

### 测试盲区

- 没有真正的客户端 UI，真实 `NetClient` 包处理器不参与；测试用自己的处理器走同一条"复制处理器表"路径。
- 没有真正跑多人联机；`hidden: true` 只有配置断言 + 源码核对。
- 转发器是单客户端的简化实现（UDP 只记最后一个客户端地址）。
- §3 的压力测试依赖真实网络，结果随网络状况波动。
