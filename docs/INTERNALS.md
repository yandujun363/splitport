# SplitPort (SRV) — 内部实现与开发笔记

面向要改这个模组的人。用户文档在 [../README.md](../README.md)。

- 模组 ID：`splitport`，版本 2.3，许可证 GPL-3.0-only。
- 本体是一个 Rhino 脚本模组：`../scripts/main.js`（入口，约 140 行）+ `../scripts/lib/*.js` + `../mod.hjson`。
- 测试脚手架：`test` 分支里就在仓库内的 `../test/`；开发机上原来是 `../../splitport-mod-dev/`。
  下文命令里的 `../../splitport-mod-dev/test` 在本分支换成 `../test/test`，
  `../../splitport-mod/scripts` 换成 `../../scripts`（工作目录都是 `test/test/`）。

---

## 0. 文件结构与脚本加载

```
scripts/
  main.js        入口：只做 require() 和 ClientLoadEvent 注册
  lib/util.js    工具函数（错误转换、IP 判断、结尾点、no-service）
  lib/routes.js  记忆路由表 + Core.settings 持久化
  lib/dns.js     DNS 客户端（记录类型 / RDLENGTH / 压缩指针 / CNAME）
  lib/srv.js     SRV 查询闸门与重试、UDP 探测、resolveRoute
  lib/net.js     ArcNetProvider/Net 子类、ping/连接入口、install()
```

**游戏只会执行 `scripts/main.js`。** `Mods.loadScripts` 的逻辑是：

```java
Seq<Fi> allScripts = mod.root.child("scripts").findAll(f -> f.extEquals("js"));
Fi main = allScripts.size == 1 ? allScripts.first() : mod.root.child("scripts").child("main.js");
if(main.exists()) scripts.run(mod, main);
```

所以 `lib/*.js` 必须由 `main.js` **在顶层**用 `require()` 拉进来。

`require` 是游戏自己装的：`mindustry.mod.Scripts` 的构造函数里用 Rhino 的
`RequireBuilder` + 一个 `ScriptModuleProvider`（把模块 id 解析到本模组 `scripts/` 下的
`<id>.js`）装到全局 scope 上。两条后果必须记住：

1. **`require()` 只能在 `main.js` 顶层调用。** 模块 id 的解析依赖 `Scripts.currentMod`，
   而它只在 `Scripts.run(mod, file)` 执行期间非 null；`ClientLoadEvent` 触发时早已清空，
   在事件回调里 `require` 会失败。
2. **模块是 sandboxed 的**（`setSandboxed(true)`）：模块可以**读**到 `global.js` 装好的全局
   （`Vars`、`Core`、`Log`、`java`/`Packages`、`ArcDns`、`extend`、`run`、`cons`……），
   但自己声明的东西不会泄漏到全局，所以每个模块通过 `module.exports` 交出 API。

依赖方向单向、无环：

```
util  <--  routes  <--  srv  <--  net  <--  main
              ^           ^
              |           |
             dns ---------+
```

（`srv` 依赖 `util`、`dns`、`routes`；`net` 依赖 `util`、`routes`、`srv`。）

拆分时踩到的两个坑，都只在**运行时**才暴露（加载本身不报错）：

- **跨模块引用必须显式导出。** 第一版拆完，`lib/net.js` 的 ping 入口用了
  `SRV_GATE_WAIT_MS` 和 `asException`，却既没从 `srv` 导出、也没在 `net` 引入，
  Rhino 只抛 `"SRV_GATE_WAIT_MS" is not defined`，而它又被 `pingHost` 最外层的兜底
  catch 吃掉 —— 现象是"服务器列表里这个条目永远无响应"，没有任何加载错误。
  这类问题**只能靠回归测试抓**。
- **原 `main.js` 的常量区最容易漏。** 拆 `routes` 模块时忘了把
  `const routes = new ConcurrentHashMap()` 一起搬走，症状同样是运行时的
  `"routes" is not defined`。

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

## 4. 纯 SRV 域名与 CNAME：为什么必须自己解析 DNS（2.3 已修复）

上游 `ArcDns.getSrvRecords(domain, nameserver)` 的解析循环把应答里的**每一条** RR 都当 SRV 读：
不看 TYPE，也不按 RDLENGTH 切片，直接读 6 字节 priority/weight/port，再按域名标签遍历 RDATA。

应答里出现 CNAME 时（`_mindustry._tcp.alias` → `_mindustry._tcp.real`）：

1. CNAME 的 RDATA 前 6 字节被读成 priority/weight/port；
2. 域名遍历从 RDATA 第 7 字节开始，越过 RDLENGTH 边界，把后面的 RR 一起吞掉；
3. 流错位之后 `builder` 可能为空，`builder.delete(builder.length() - 1, builder.length())`
   就成了 `delete(-1, 0)` → `StringIndexOutOfBoundsException`。

这是 **RuntimeException**，`ArcDns.getSrvRecords(domain)`（只 catch IOException）和原版
`ArcNetProvider.pingHost`（同样只 catch IOException）都不会捕获它：

- **原版**：异常逃出 `pingHost`，被 `Net.pingExecutor.submit()` 的 Future 静默吞掉，
  `valid`/`invalid` 都不回调 → 列表条目永远"刷新中"。
- **MindustryX**：`patches/client/0061-H-replace-pingHost-with-PingService.patch` 把
  `Net.pingHost` 整个换成了 `PingService.INSTANCE.pingHost(...)`，而它第一步
  `InetAddress.getByName(address)` 对纯 SRV 域名必然抛 `UnknownHostException`，并且同样
  没有任何 catch → 一样永远"刷新中"。

**推论（很重要）**：在 MindustryX 上，2.2 及更早版本的 `provider.pingHost` 覆盖**根本不会被
调用**，只有 `connectClient` 生效。用户日志里那些 `[SplitPort] SRV ... -> ...` 行来自
`connectClient → resolveRoute`，不是 PING。要在这类构建上生效，必须覆盖 `Net` 本身。

2.3 的做法：

1. `dnsBuildQuery()` / `dnsReceive()` / `dnsExchange()` / `dnsName()` / `dnsParseAnswer()` /
   `dnsQueryOnce()` 自己收发并解析 DNS：按 TYPE 分发、按 RDLENGTH 切片、支持 0xC0 压缩指针、
   跟随 CNAME（同应答里有 SRV 就直接用，只有 CNAME 就用目标名重查，深度上限 `DNS_CNAME_DEPTH`，
   `HashSet` 防环）。
2. `install()` 里用 `extend(Net, provider, {...})` **覆盖 `Net.pingHost` 本身**，
   `provider.pingHost` 保留给仍然走 provider 的构建；子类化失败回退到 `new Net(provider)`。
3. `doPing()` 负责把工作挪出调用线程（`Threads.daemon`）：原版由 `pingExecutor` 调用，
   MindustryX 由 `mainExecutor` 调用，而覆盖之后调用线程就是渲染线程。
4. `doConnect()` 对"域名 + 默认端口"总是先查一次 SRV，DNS 没结果才用记忆路由；
   连接抛异常时 `forgetRoute()` 删掉那条过期路由（NAT 端口变了以后它只会一直超时）。

`SplitPortHarness` 场景 9 覆盖了完整链路：本地 DNS 故意把 CNAME 之后的第二条记录的 owner
写成指向 CNAME RDATA 的压缩指针。

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
8. **循环体内不要用 `const`（这条 2.3 又踩了一次）。** `dnsName()` 的第一版在 `while` 里写了
   `const len = msg.charCodeAt(pos)`，Rhino 优化器把它折叠成首次取值，于是解析出来的记录流全是错的
   —— 表面现象是"SRV 查询永远查不到记录"，没有异常、没有日志。第 2 条不是理论。
9. **`new java.lang.String(...)` 不是 JS 字符串。** Rhino 把 `java.lang.String` 当 Java 对象包着，
   `charCodeAt()` / `substring()` 不会按 JS 字符串工作。DNS 应答转文本时必须显式写一次 `"" + ...`
   转成 JS 字符串（见 `dnsText()`），否则 `charCodeAt` 抛错、被 catch 吞掉，同样是"永远查不到记录"。
10. **单个函数的局部变量不能太多。** `dnsExchange()` 最初把"构造查询 + 收发 + 校验"写在一起，
    Rhino 优化器生成 StackMapTable 时直接
    `ArrayIndexOutOfBoundsException: arraycopy: last source index 33 out of bounds for object array[32]`，
    整份脚本都编译不过（`Context.evaluateString` 阶段就炸，游戏里表现为模组加载失败）。
    拆成 `dnsBuildQuery()` / `dnsReceive()` / `dnsExchange()` 三个函数即可。
    `../../splitport-mod-dev/test/RhinoCheck.java` 会逐个顶层函数编译，可以直接定位这类问题。

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
**真实 Arc / Rhino / 游戏类**，并按游戏同款方式（先装 `require`，再跑 `main.js`，
见 §0）加载**真正的脚本**：

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
| `test/SplitPortHarness.java` | 离线集成测试：本地转发器扮演 NAT（服务器内部仍是单端口，对外是 12565/TCP + 12566/UDP），本地 DNS 服务器发布 SRV（含 CNAME 别名），跑完 10 个场景 |
| `test/SrvGate.java` | 复现 DNS 并发丢包：400 次查询在 1/4/8/16/64/400 并发下的丢失率 |
| `test/SrvStress.java` | 用真实社区列表按 `JoinDialog` 的方式整表刷新，检查目标服务器每次都能解析出正确的两个端口 |
| `test/LivePing.java` | 对真实服务器跑"ping 域名 → 收藏成 ip:端口 → 再 ping 收藏"的完整链路 |
| `test/ConcurrentPing.java` | 266 条社区条目并发 ping，检查每一个都恰好回调一次 |
| `test/ModLoader.java` | 复刻游戏的脚本加载：装同款 `require`（`RequireBuilder` + `setSandboxed(true)`）再跑 `main.js`。所有测试都通过它加载模组，否则测的就不是游戏真实走的路径 |
| `test/RhinoCheck.java` | 逐个模块、逐个顶层函数用游戏自带 Rhino 编译，定位"优化器编译不过"的函数（见 §5 第 10 条） |
| `test/CnameCase.java` | 真实服务器对照：原版 / 模组 / 带过期记忆路由，分别在 CNAME 域名上的表现 |
| `test/DnsDump.java` | 抓真实 DNS 应答并逐字节重放 `ArcDns` 的解析循环，展示它在哪一步错位 |

`SplitPortHarness` 覆盖的场景（全部 PASS）：

1. 安装：`Vars.net` 被替换、客户端/服务端包处理器数量与安装前一致、`mod.hjson` 里 `hidden: true`；
2. `_tcp` + `_udp` 分离端口，并像 `JoinDialog` 那样用 **ping 出来的数字 IP + TCP 端口**去连接；
3. 没有 SRV → 完全走原版单端口；
4. 只有 `_udp` → UDP 用 SRV 端口，TCP 用请求的端口；
5. 只有 `_tcp` → 等同原版 SRV 回退；
6. 第一条 `_udp` 记录不可达 → 自动用第二条；
7. 收藏夹形式（`ip:tcpPort`）的重复 ping；
8. 模拟重启（全新的 Rhino 作用域 + 空的路由表）后，只靠 settings 里的记忆路由 ping 通；
9. 自己开服（`Vars.net.host`）时 TCP/UDP 两个端口都正常绑定；
10. `_mindustry._tcp` / `_mindustry._udp` 本身是 CNAME（应答里第二条记录的 owner 用压缩指针
    指回 CNAME 的 RDATA）时，ping 与连接都正常。

改动 `main.js` 后请至少跑一遍 `SplitPortHarness`；改到 ping 逻辑时再跑 `SrvStress` / `LivePing`
（需要真实网络，参数见 `../../splitport-mod-dev/README.md`）。

### 测试盲区

- 没有真正的客户端 UI，真实 `NetClient` 包处理器不参与；测试用自己的处理器走同一条"复制处理器表"路径。
- 没有真正跑多人联机；`hidden: true` 只有配置断言 + 源码核对。
- 转发器是单客户端的简化实现（UDP 只记最后一个客户端地址）。
- §3 的压力测试依赖真实网络，结果随网络状况波动。
