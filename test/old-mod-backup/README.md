# Split Port (SRV) — Mindustry 客户端模组

让客户端在连接服务器时，**分别解析并使用 TCP 端口和 UDP 端口**。

## 解决什么问题

Mindustry（以及它依赖的 Arc）在网络层其实支持 TCP/UDP 用不同端口，但游戏代码里把同一个端口值填了两次：

```java
// ArcNetProvider.hostServer
server.bind(port, port);
// ArcNetProvider.connectClient
client.connect(5000, ip, port, port);
```

所以当服务器经过 NAT/端口转发后，对外的 **TCP 端口和 UDP 端口不是同一个**时，原版客户端无法连接（它会拿同一个端口去连两种协议）。

本模组**只改客户端运行时行为，不修改任何游戏源码**：它在运行时把游戏的 `NetProvider` 换成一个 `ArcNetProvider` 子类，在 ping 阶段同时查询：

- `_mindustry._tcp.<域名>` → TCP 端口
- `_mindustry._udp.<域名>` → UDP 端口

然后用 UDP 端口做 ping（ping 本身只能走 UDP），用 TCP 端口去建立连接。

## 安装

把整个 `splitport-mod` 目录（或 `splitport-mod.zip`）放进游戏的 `mods` 目录：

- Windows：`%APPDATA%\Mindustry\mods\`
- Linux：`~/.local/share/Mindustry/mods/`
- macOS：`~/Library/Application Support/Mindustry/mods/`
- Android：`/storage/emulated/0/Android/data/io.anuke.mindustry/files/mods/`

启动后日志出现下面这行即生效：

```
[SplitPort] installed: _mindustry._tcp/_udp dual-port SRV lookup active.
```

> 该模组用了 `JavaAdapter`/反射，因此不兼容 iOS（`iosCompatible` 默认关闭）。Steam 版本会自动跳过（Steam 连接没有端口概念）。

## 服务器侧需要做的（只有 DNS）

在域名上发布两条 SRV 记录，端口填 **NAT 对外**的端口。例如对外 TCP `25565`、UDP `25566`：

```
_mindustry._tcp.example.com.  300 IN SRV 10 10 25565 tcp.example.com.
_mindustry._udp.example.com.  300 IN SRV 10 10 25566 udp.example.com.
```

要点：

1. **`_udp` 记录是必需的**。原版 Mindustry 服务器基本都不发布 `_udp`；没有它，客户端只能假设 UDP 端口等于 TCP 端口。
2. 两条记录的 target **应指向同一台主机**（可以是同一个域名）。Arc 的 `Client.connect(timeout, host, tcpPort, udpPort)` 只接受一个主机地址，TCP/UDP 共用。
3. 玩家用**域名 + 默认端口 6567**加入（例如在添加服务器里填 `example.com`）。填了非默认端口时不会走 SRV，而是把该端口同时当成 TCP/UDP。

## 工作流程

1. `pingHost` 时，若地址是域名且端口为默认 6567：
   - 查 `_mindustry._tcp` / `_mindustry._udp`；
   - 用 `_udp` 的 target:port 发 UDP ping 获取服务器信息；
   - 记住 `服务器IP:TCP端口 -> UDP端口`，并把 `Host.port` 设为 **TCP** 端口；
   - 没有 `_udp` 时回退为 TCP 端口（等同原版行为）。
2. 点击加入时，`connectClient` 用 `client.connect(5000, ip, tcpPort, udpPort)`。
3. 学到的映射会存进 settings（`splitport-map`），因此**收藏夹里以 IP 保存的服务器**在重启后依然能正确使用分离端口。
4. SRV 查询失败/记录不存在 → 自动回退到原版单端口逻辑。

## 限制

- 需要域名 + SRV；纯 IP 直连无法自动发现分离端口（这是"客户端手动输入两个端口"方案要解决的，未包含在本版本内）。
- `_tcp` 与 `_udp` 的 target 需解析到同一 IP。
- 原版客户端无法连接分离端口的服务器（本模组只改客户端，服务器保持原版即可）。
- `ArcDns` 的 SRV 解析器不校验记录类型、不支持 RDATA 名称压缩指针；绝大多数 DNS 符合 RFC 2782（SRV target 不压缩），实测正常，但不合规的 DNS 可能导致查询失败并回退到单端口。

## 文件

- `mod.hjson` — 模组元数据
- `scripts/main.js` — 全部逻辑
- `splitport-mod.zip` — 打包好的安装包

## 排错

看日志里的 `[SplitPort]` 前缀：

- `installed: _mindustry._tcp/_udp dual-port SRV lookup active.` — 安装成功。
- `example.com -> tcp.example.com / TCP 25565 / UDP 25566` — SRV 解析成功，接下来会按这两个端口连接；如果端口不对，检查 DNS 记录。
- `connecting openwrt.example.xyz - TCP 25565 / UDP 25566` — 实际连接使用的目标与两个端口。**注意目标应是 SRV 里的 target 主机名，而不是你输入的纯 SRV 域名。**
- 没有出现 `->` 行说明没查到 SRV（域名拼写、`_udp` 记录缺失，或 DNS 不响应）。
- `SRV target ... unreachable` / `SRV lookup failed` — 记录存在但服务器没回应或 DNS 异常，会自动回退。

### 纯 SRV 域名（没有 A 记录）

如果域名只有 `_mindustry._tcp` / `_mindustry._udp` 两条 SRV，而它自己没有 A/AAAA 记录（例如 `mdt-v4-srv.play.jiahai.top`），那么直接对域名调用 `InetAddress.getByName` 会抛 `UnknownHostException`。

原始问题：加入服务器时，如果服务器信息 ping 还没完成（`server.lastHost == null`），`JoinDialog` 会直接 `connect(域名, 端口)`，Arc 便会去解析这个没有 A 记录的域名，导致：

```
java.net.UnknownHostException: <你的纯 SRV 域名>
```

现在 `connectClient` 也会自己做一次 SRV 解析：把连接目标替换成 SRV 的 **target** 主机名，并分别使用 `_tcp` / `_udp` 的端口，所以即使没有先 ping 成功也能连上。`pingHost` 和 `connectClient` 两条路径都会解析 SRV。

### 关于 Rhino 正则崩溃

日志里如果出现：

```
java.lang.IllegalStateException: FAILED ASSERTION: invalid bytecode
        at rhino.regexp.NativeRegExp.executeREBytecode(...)
        at rhino.gen.split_port_srv_main_js_3._c_anonymous_2(split-port-srv/main.js:23)
```

这是 **Rhino 正则引擎的 bug**：在优化级别 9 下，从非主线程（ping 线程 / 连接线程）执行正则表达式时，编译后的正则字节码会被破坏。注意它发生在 `client.connect` **之前**，所以会掩盖真正的连接过程。

模组因此**完全移除了正则表达式**：`isIpAddress` 改用普通字符串遍历实现，`stripDot` 也改为纯字符串操作。如果后续再改这个模组，**不要在后台线程执行正则**。

> 注意：Rhino 会把捕获到的 Java 异常包装成 JS `Error` 对象，不能直接传给 `Net.handleException(Throwable)`。模组内部用 `asThrowable()` 取回 `.javaException` 再传递，因此不会出现 `Can't find method ... handleException(object)`。
