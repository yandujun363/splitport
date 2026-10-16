// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 yandujun363
//
// SplitPort (SRV) - client-side-only Mindustry mod.
// Repository / release links: not published yet.
//
// This script is GPL-3.0-only because it links against Mindustry (GPL-3.0)
// at runtime: it subclasses mindustry.net.ArcNetProvider through JavaAdapter
// and reads private fields of mindustry.net.Net. See README.md, section
// "许可证", for the full reasoning. arc (Apache-2.0) is the only other
// upstream involved and is license-compatible.
// =====================================================================
// SplitPort (SRV) - a client-side-only Mindustry mod
//
// Why this exists
// ---------------
// Mindustry (through Arc) *can* talk to a server on two different ports,
// but the game always passes the same value for both:
//
//     ArcNetProvider.connectClient : client.connect(5000, ip, port, port)
//     ArcNetProvider.hostServer    : server.bind(port, port)
//
// Behind NAT the external TCP port and the external UDP port are often not
// the same, so a vanilla client cannot join such a server.
//
// What this mod does
// ------------------
//   * looks up   _mindustry._tcp.<address>   -> TCP port
//          and   _mindustry._udp.<address>   -> UDP port
//   * UDP-pings the _udp target (server discovery is UDP-only) and reports
//     the *TCP* port to the game as Host.port
//   * on join, calls client.connect(5000, host, tcpPort, udpPort)
//   * if no suitable SRV record exists (or the SRV target does not answer),
//     it falls back to the vanilla single-port behaviour, including
//     vanilla's own _mindustry._tcp fallback.
//
// Why the previous version could replace the port but never join a game
// ---------------------------------------------------------------------
// It did `Vars.net = new Net(provider)`. NetClient and NetServer register
// all of their packet handlers on the Net instance that exists when they
// are constructed (ClientLauncher.init / Vars.init), which happens *before*
// mod scripts run. The freshly created Net had no listeners at all, so the
// Connect/WorldStream handshake never happened and the client just hung.
//
// The fix used here: build a new Net but first copy the (private) listener
// maps of the old Net into it, then swap Vars.net. The listener maps are
// only *read* through reflection - no final field is ever mutated, so this
// keeps working on current and future JDKs.
//
// 2.3 replaced that plain Net with a Net *subclass* that overrides pingHost
// directly, because MindustryX routes Net.pingHost to its own PingService and
// never calls the ArcNetProvider hook at all. Subclassing is best-effort: if
// Net cannot be extended, lib/net.js falls back to a plain Net.
//
// Multiplayer compatibility
// -------------------------
// mod.hjson sets `hidden: true`. Mods.getModStrings() (the list exchanged
// during the multiplayer handshake) skips hidden mods, so a server does not
// need this mod and never kicks you for having it.
//
// Why a "ping probe failed" showed up in the server list
// -----------------------------------------------------
// ArcDns.getSrvRecords(domain) swallows every IOException and returns an EMPTY
// list, which is indistinguishable from "this server publishes no SRV record".
// JoinDialog refreshes the community list by pinging ~270 entries at once on an
// unbounded thread pool, and the system resolver simply drops UDP DNS queries
// when it is flooded. Measured on a real resolver:
//
//     concurrent SRV queries:   1    4    8    16   64   400
//     queries that came back:  100% 100% 100% 99%  59%  71%
//
// So most SRV lookups silently "found nothing", the mod fell back to the vanilla
// single-port ping, and for a domain that only exists through SRV (no A record)
// that ping fails - the entry shows as not responding, while joining still
// works because a join performs a single, uncontended lookup.
//
// The mod therefore (a) calls the two-argument ArcDns.getSrvRecords() that
// THROWS, so "no record" and "no answer" can be told apart, (b) limits how many
// SRV queries are in flight at once, and (c) retries the ones that got no
// answer at all.
//
// Rhino / JS rules this mod sticks to (all of them were hit for real)
// ------------------------------------------------------------------
// 1. NO regular expressions. Rhino's NativeRegExp caches compiled bytecode
//    and throws "FAILED ASSERTION: invalid bytecode" when a regex runs on a
//    non-main thread (the ping pool / connect thread). Java's String.split()
//    is safe, but plain indexOf/substring is used throughout anyway.
// 2. NEVER declare a loop-body local with `const`. In Rhino's optimizer a
//    `const` inside a loop is folded to its first evaluation, e.g.
//        for(let i = 0; i < a.length; i++){ const k = a[i]; ... }
//    yields a[0] on every iteration. Use `let` inside loops.
// 3. Imported Java *classes* (NativeJavaClass) do not expose java.lang.Class'
//    own methods, so `SomeClass.getDeclaredField(..)` fails. Use
//    Class.forName("...") (see javaClass()) which returns a usable Class.
// 4. Do not store plain JS objects in Java collections that are read from
//    other threads; keys and values here are real java.lang.String instances.
// 5. Arc's ObjectMap iterator wrappers are package-private classes, so
//    iterate with keys()/values().toSeq().toArray(), not the iterator itself.
// =====================================================================

// ---------------------------------------------------------------------

// module layout

//

// The game only ever runs scripts/main.js; everything else is pulled in here

// with require(), which the game installs itself (mindustry.mod.Scripts

// builds a CommonJS loader whose ids resolve against this scripts/ folder).

// Modules are sandboxed: they can read the globals global.js installed, but

// their own names stay private, so each one hands out its API through

// module.exports.

//

//   lib/util.js    small helpers (no regexes, no loop-body const)

//   lib/routes.js  routes learned from DNS, persisted in Core.settings

//   lib/dns.js     DNS client: record types, RDLENGTH, compression, CNAME

//   lib/srv.js     SRV discovery, gated queries, UDP probing

//   lib/net.js     ArcNetProvider/Net subclass, ping/connect, install()

// ---------------------------------------------------------------------


const util = require("lib/util");
const net = require("lib/net");

// ClientLoadEvent fires on the main thread after every module (including
// NetClient/NetServer) has been constructed and initialised.
Events.on(ClientLoadEvent, cons(e => {
    try{
        net.install();
    }catch(e){
        Log.err("[SplitPort] failed to install; the game will keep using the vanilla net provider.");
        Log.err(util.asThrowable(e));
    }
}));
