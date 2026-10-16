# splitport-mod 开发 / 测试环境

这是 `test` 分支上的测试脚手架，**不属于模组本体**。仓库内布局：

```
<repo>/
  mod.hjson  scripts/  docs/  README.md ...   模组本体（与 main 分支一致）
  test/                                       本脚手架
    README.md                                 本文件
    refs/                                     Mindustry v160.7 发布包（jar 随脚手架提交）
    old-mod-backup/                           v1 旧模组备份
    test/                                     测试源码
```

下文命令都假设你**站在 `test/test/` 目录**执行，因此模组本体用 `../../` 引用
（`../../scripts/main.js`、`../../mod.hjson`）。在开发机上脚手架原本放在
`splitport-mod-dev/`，那时同样的路径写成 `../../splitport-mod/...`。

## 内容

```
refs/
  server-release.jar     Mindustry v160.7 官方 headless 服务端（含核心类 + Arc + Rhino）
  dependencies.jar       Mindustry v160.7 运行时依赖（arc / rhino / ...）
  x/scripts/global.js    从 dependencies.jar 里解出来的 Mindustry JS 模组全局环境
old-mod-backup/          v1 旧模组原文件备份
test/
  old/main-prefix.js     v2.0（修复前）的 main.js，用于 A/B 对比
  SplitPortHarness.java  离线集成测试（10 个场景，含 CNAME + 压缩指针）
  SrvGate.java           DNS 并发丢包率测量
  SrvStress.java         真实社区列表整表刷新压力测试（A/B）
  LivePing.java          真实服务器上的完整 ping 链路测试
  ConcurrentPing.java    266 条并发 ping，检查每个都恰好回调一次
  Measure.java / NsProbe.java / NsList.java   DNS / RTT / nameserver 诊断小工具
  ModLoader.java         复刻游戏的脚本加载：装同款 require 再跑 main.js（测试都经它加载）
  RhinoCheck.java        逐个模块、逐个顶层函数用 Rhino 编译，定位"优化器编译不过"的函数
  CnameCase.java         真实服务器对照：vanilla / 模组 / 带过期记忆路由，在 CNAME 域名上的表现
  DnsCheck.java          直接用 ArcDns 查两个域名，对比"有 CNAME"和"没 CNAME"
  DnsDump.java           抓真实应答并逐字节重放 ArcDns 的解析循环
  out/                   编译输出（已被 .gitignore 忽略，clone 后自己 javac 生成）
```

## 编译与运行

```bash
cd test/test
javac -nowarn -cp ../refs/server-release.jar -d out *.java
```

### 1. 离线集成测试（主要回归测试）

```bash
java -cp out:../refs/server-release.jar SplitPortHarness \
     ../refs/x/scripts/global.js \
     ../../scripts/main.js \
     ../../mod.hjson
```

退出码 0 = 全部通过。用官方包里的**真实** Arc 网络栈、**真实** Mindustry Rhino、
以及 `scripts/global.js` 提供的 JS 全局环境加载**真正的 `main.js`**：

```
[mod 客户端] --TCP--> 本地转发:12565 --TCP--> 单端口服务器 127.0.0.1:16567
[mod 客户端] --UDP--> 本地转发:12566 --UDP--> 单端口服务器 127.0.0.1:16567
```

- 服务器用 `arc.net.Server` + 游戏自己的 `ArcNetProvider.PacketSerializer` 起，
  和原版一样 `bind(port, port)`（单端口）。
- 两个本地转发器扮演 NAT：对外只有 12565/TCP 和 12566/UDP。
- 本地 DNS 服务器（127.0.0.1:15353）回答 SRV 查询，通过 `ArcDns.setNameserverProviders(...)`
  注入，不影响系统 DNS。
- `Core.app` 用 `arc.mock.MockApplication`，`pingHost` 回调同步执行。

场景：

| # | 场景 | 断言 |
| - | --- | --- |
| 0 | 安装 | `Vars.net` 被替换、客户端/服务端包处理器数量与安装前一致、`mod.hjson` 里 `hidden: true` |
| 1 | `_tcp` + `_udp` 分离端口 | ping 返回 `Host.port == 对外 TCP 端口`、`Host.address` 是解析出的 IP；随后用 `Host.address:Host.port` 连接，客户端收到 `Connect`，服务端完成 TCP+UDP 注册 |
| 2 | 没有 SRV | 完全等同原版单端口 |
| 3 | 只有 `_udp` | UDP 用 SRV 端口，TCP 用请求的端口 |
| 4 | 只有 `_tcp` | 等同原版 SRV 回退（两种协议同端口） |
| 5 | 第一条 `_udp` 记录不可达 | 自动改用第二条 |
| 6 | 收藏夹形式 `ip:tcpPort` 的重复 ping | 必须成功且端口仍是 TCP 端口 |
| 7 | 模拟重启 | 换一个全新的 Rhino 作用域 + 空路由表，只靠 settings 里恢复的路由 ping 通 |
| 8 | 自己开服 | `Vars.net.host()` 后 TCP/UDP 两个端口都被占用 |

### 2. DNS 并发丢包复现（解释 PING 失效的根因）

```bash
java -cp out:../refs/server-release.jar SrvGate
```

400 次查询在不同并发下的丢失率（本机实测）：

```
limit=1     loss=0%
limit=4     loss=0%
limit=8     loss=0%      ← 模组用这个值
limit=16    loss=0.75%
limit=64    loss=41%
limit=400   loss=29%
```

### 3. 整表刷新压力测试（A/B 旧版 vs 新版）

需要一个真实服务器域名 + 期望的 TCP 端口。参数：
`global.js main.js servers.json <域名> <期望TCP端口> <每次刷新的条目数> <刷新轮数>`

```bash
# 修复前
java -cp out:../refs/server-release.jar SrvStress \
     ../refs/x/scripts/global.js old/main-prefix.js /tmp/servers_v8.json \
     mdt-v4-srv.play.jiahai.top 23608 6 10

# 修复后
java -cp out:../refs/server-release.jar SrvStress \
     ../refs/x/scripts/global.js ../../scripts/main.js /tmp/servers_v8.json \
     mdt-v4-srv.play.jiahai.top 23608 6 10
```

每次"刷新"= 社区列表全部条目（266 条）**同时** ping + 目标服务器若干条，和
`JoinDialog.refreshRemote()` 的行为一致。社区列表来自：

```bash
curl -o /tmp/servers_v8.json https://raw.githubusercontent.com/Anuken/MindustryServerList/master/servers_v8.json
```

### 4. 真实服务器 ping 链路

```bash
java -cp out:../refs/server-release.jar LivePing \
     ../refs/x/scripts/global.js ../../scripts/main.js mdt-v4-srv.play.jiahai.top
```

依次 ping：域名 → 把结果当成收藏夹（`<IP>:<TCP端口>`）再 ping → 直接 ping 原始 UDP 端口。

### 5. 266 条并发 ping 回调完整性

```bash
java -cp out:../refs/server-release.jar ConcurrentPing \
     ../refs/x/scripts/global.js ../../scripts/main.js /tmp/servers_v8.json x
```

最后一个参数 `vanilla` 可以跳过模组安装，作为原版基线对比耗时。

## 已知的测试盲区

- 没有跑真正的客户端 UI（无显示器），所以 `NetClient` 的真实包处理器没有参与；
  测试用自己的处理器替代，走的是同一条"复制处理器表"代码路径。
- 没有真正跑多人联机（无法在这里起两个完整客户端）；
  `hidden: true` 只做了配置断言 + 源码核对（`Mods.getModStrings()` 过滤 `meta.hidden`）。
- 转发器是单客户端的简化实现（UDP 只记最后一个客户端地址），够测试用。
- §3 的压力测试依赖真实网络，结果会随网络状况波动；衡量"错误端口"的比例最稳定。
