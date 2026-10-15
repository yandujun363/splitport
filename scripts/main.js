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
// Rhino / JS rules this file sticks to (all of them were hit for real)
// ------------------------------------------------------------------
// 1. NO regular expressions. Rhino's NativeRegExp caches compiled bytecode
//    and throws "FAILED ASSERTION: invalid bytecode" when a regex runs on a
//    non-main thread (the ping pool / connect thread). Java's String.split()
//    is safe, but plain indexOf/substring is used here anyway.
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

const TCP_SRV_PREFIX = "_mindustry._tcp.";
const UDP_SRV_PREFIX = "_mindustry._udp.";

/** How long to wait for a discovery reply, matching vanilla. */
const PING_TIMEOUT = 2000;

/** connect timeout, matching ArcNetProvider.connectClient. */
const CONNECT_TIMEOUT = 5000;

/** How many SRV queries may be in flight at once. The local resolver starts
 *  dropping answers somewhere above ~16 concurrent lookups (see the table
 *  above), and 8 measured a 0% loss rate. */
const SRV_MAX_CONCURRENT = 8;

/** Attempts per SRV query when the resolver did not answer at all. */
const SRV_ATTEMPTS = 3;

/** Base delay between SRV attempts, in milliseconds. */
const SRV_RETRY_DELAY = 60;

/** Longest a ping may wait for the SRV gate. A server-list refresh asks for
 *  hundreds of SRV lookups at once; without a bound, a single ping could queue
 *  behind all of them and the entry would spin on "refreshing" for minutes.
 *  Past this wait the lookup is treated as unanswered and the ping falls back
 *  to a route it already knows or to the plain single-port ping. */
const SRV_GATE_WAIT_MS = 2500;

/** The same wait when a route for this exact address:port is already known.
 *  DNS only needs a brief chance to correct/refresh it; if the SRV gate is
 *  busy with a community-list refresh the remembered route is used instead. */
const SRV_GATE_WAIT_KNOWN_MS = 300;

/** Where learned routes are remembered across restarts. */
const ROUTES_SETTING = "splitport-routes";
const MAX_PERSISTED_ROUTES = 128;

/** Extra attempts for the UDP discovery ping of an SRV target. JoinDialog pings
 *  the whole community list at once, and under that burst a single UDP datagram
 *  (request or reply) does get dropped - which made a split-port server show up
 *  as "not responding". Only SRV targets are retried; the plain ping keeps
 *  vanilla's timing exactly. */
const SRV_PING_ATTEMPTS = 3;
/** Delay before attempt 2 and 3. The burst of ~270 simultaneous pings lasts a
 *  couple of seconds and a cheap router drops UDP flows while its NAT table is
 *  full, so a retry that is still inside the burst is pointless - the second
 *  one waits for the burst to drain. */
const PING_RETRY_DELAYS = [250, 1500];

/** Fair semaphore so a burst of pings cannot starve one server forever. */
const srvGate = new java.util.concurrent.Semaphore(SRV_MAX_CONCURRENT, true);

/** "address:port" -> "host|tcpPort|udpPort".
 *  A ConcurrentHashMap is used because this map is written from the ping
 *  thread pool and read from the connect thread. Keys and values are forced
 *  to real java.lang.String instances so that equals()/hashCode() behave. */
const routes = new java.util.concurrent.ConcurrentHashMap();

let installed = false;
let clientField = null;
let provider = null;

// ---------------------------------------------------------------------
// small helpers (no regex!)
// ---------------------------------------------------------------------

function errText(e){
    try{
        if(e === null) return "null";
        if(e === undefined) return "undefined";
        if(e.message !== undefined && e.message !== null) return "" + e.message;
        return "" + e;
    }catch(ignored){
        return "unknown error";
    }
}

/** An exception thrown *by* Java code and caught in JS arrives either as the
 *  raw Throwable or wrapped in Rhino's WrappedException (which also carries
 *  the original in a `.javaException` property in Mindustry's Rhino fork).
 *  Net.handleException needs the real Throwable, so unwrap it here. */
function asThrowable(e){
    try{
        if(e !== null && e !== undefined){
            if(e instanceof java.lang.Throwable){
                // WrappedException.getWrappedException(); absent on anything else
                try{
                    const wrapped = e.getWrappedException();
                    if(wrapped !== null && wrapped !== undefined) return wrapped;
                }catch(notWrapped){
                }
                return e;
            }
            if(e.javaException !== undefined && e.javaException !== null) return e.javaException;
            if(e.rhinoException !== undefined && e.rhinoException !== null) return e.rhinoException;
        }
    }catch(ignored){
    }
    return new java.lang.RuntimeException(errText(e));
}

/** Same as asThrowable, but guaranteed to return an Exception (for Cons<Exception>). */
function asException(e){
    const t = asThrowable(e);
    try{
        if(t instanceof java.lang.Exception) return t;
    }catch(ignored){
    }
    return new java.lang.RuntimeException(errText(e));
}

/** True for IPv4 literals and for anything containing ':' (IPv6 literals). */
function isIpAddress(address){
    if(address === null || address === undefined) return false;
    const s = "" + address;
    if(s.length === 0) return false;
    if(s.indexOf(":") !== -1) return true;

    let dots = 0, partLength = 0;
    for(let i = 0; i < s.length; i++){
        let c = s.charCodeAt(i);
        if(c === 46){ // '.'
            if(partLength === 0 || partLength > 3) return false;
            dots++;
            partLength = 0;
        }else if(c >= 48 && c <= 57){ // '0'-'9'
            partLength++;
        }else{
            return false;
        }
    }
    return dots === 3 && partLength > 0 && partLength <= 3;
}

/** ArcDns returns targets without a trailing dot, but be defensive.
 *  RFC 2782 also allows a single "." to mean "service not available". */
function stripDot(host){
    try{
        if(host === null || host === undefined) return null;
        const s = "" + host;
        if(s.length > 1 && s.charAt(s.length - 1) === ".") return s.substring(0, s.length - 1);
        return s;
    }catch(ignored){
        return null;
    }
}

function isNoService(host){
    return host === null || host === undefined || host === "" || host === ".";
}

// ---------------------------------------------------------------------
// route table
// ---------------------------------------------------------------------

function routeKey(address, port){
    return new java.lang.String("" + address + ":" + port);
}

/** Remember how to reach a server. `host` may be a literal IP or a hostname. */
function putRoute(address, port, host, tcpPort, udpPort){
    try{
        routes.put(routeKey(address, port),
            new java.lang.String("" + host + "|" + tcpPort + "|" + udpPort));
        if(tcpPort !== udpPort) saveRoutes();
    }catch(e){
        Log.warn("[SplitPort] could not store route for @: @", address, errText(e));
    }
}

/** @return {host, tcp, udp} or null. */
function getRoute(address, port){
    try{
        const value = routes.get(routeKey(address, port));
        if(value === null || value === undefined) return null;
        return parseRouteValue("" + value);
    }catch(e){
        return null;
    }
}

function parseRouteValue(s){
    const first = s.indexOf("|");
    if(first < 0) return null;
    const second = s.indexOf("|", first + 1);
    if(second < 0) return null;

    const tcp = Number(s.substring(first + 1, second));
    const udp = Number(s.substring(second + 1));
    if(!(tcp > 0) || !(udp > 0)) return null;

    return {host: s.substring(0, first), tcp: tcp, udp: udp};
}

/** Routes are kept in settings so that favourites stored as "ip:tcpPort"
 *  (JoinDialog.addCommunityHost saves exactly that) can still be pinged after
 *  the game is restarted, when no DNS name is available any more. */
function loadRoutes(){
    try{
        const saved = Core.settings.getString(ROUTES_SETTING, "");
        if(saved === null || saved === undefined || ("" + saved).length === 0) return;

        const entries = ("" + saved).split(";");
        let restored = 0;

        for(let i = 0; i < entries.length; i++){
            const entry = entries[i];
            if(entry.length === 0) continue;

            // "address|port|host|tcp|udp"
            const f = entry.split("|");
            if(f.length !== 5) continue;

            const address = "" + f[0];
            const port = Number("" + f[1]);
            const route = parseRouteValue("" + f[2] + "|" + f[3] + "|" + f[4]);
            if(address.length === 0 || !(port > 0) || route === null || route.tcp === route.udp) continue;

            routes.put(routeKey(address, port), new java.lang.String("" + f[2] + "|" + f[3] + "|" + f[4]));
            restored++;
        }

        if(restored > 0){
            Log.info("[SplitPort] restored @ remembered split-port route(s)", "" + restored);
        }
    }catch(e){
        Log.warn("[SplitPort] could not read remembered routes: @", errText(e));
    }
}

function saveRoutes(){
    try{
        const keys = routes.keySet().toArray();
        let out = "";
        let count = 0;

        for(let i = 0; i < keys.length && count < MAX_PERSISTED_ROUTES; i++){
            const key = "" + keys[i];
            const value = "" + routes.get(keys[i]);
            const route = parseRouteValue(value);
            if(route === null || route.tcp === route.udp) continue;

            const sep = key.lastIndexOf(":");
            if(sep <= 0) continue;
            const address = key.substring(0, sep);
            const port = key.substring(sep + 1);

            if(out.length > 0) out += ";";
            out += address + "|" + port + "|" + value;
            count++;
        }

        Core.settings.put(ROUTES_SETTING, out);
    }catch(e){
        Log.warn("[SplitPort] could not remember routes: @", errText(e));
    }
}

// ---------------------------------------------------------------------
// server discovery ping (UDP only - this is what the game's ping uses)
// ---------------------------------------------------------------------

/** Sends the {-2, 1} discovery datagram and parses the reply.
 *  Throws on timeout / unknown host, exactly like vanilla's pingHostImpl. */
function rawPing(address, port){
    const socket = new java.net.DatagramSocket();
    try{
        const start = Time.millis();

        const request = java.nio.ByteBuffer.allocate(2).put(-2).put(1).array();
        socket.send(new java.net.DatagramPacket(request, request.length,
            java.net.InetAddress.getByName(address), port));
        socket.setSoTimeout(PING_TIMEOUT);

        const data = new java.nio.ByteBuffer.allocate(1024).array();
        const packet = new java.net.DatagramPacket(data, data.length);
        socket.receive(packet);

        const buffer = java.nio.ByteBuffer.wrap(packet.getData(), 0, packet.getLength());
        return NetworkIO.readServerData(Time.timeSinceMillis(start),
            packet.getAddress().getHostAddress(), buffer);
    }finally{
        try{
            socket.close();
        }catch(ignored){
        }
    }
}

/** Discovery ping with a couple of attempts. A lost UDP datagram under the
 *  server-list burst is common enough to matter for the few servers that
 *  actually publish SRV records. Throws the last error when all attempts fail. */
function pingRetry(address, port){
    let last = null;

    for(let i = 0; i < SRV_PING_ATTEMPTS; i++){
        try{
            return rawPing(address, port);
        }catch(e){
            last = e;
            if(i < PING_RETRY_DELAYS.length){
                try{
                    java.lang.Thread.sleep(PING_RETRY_DELAYS[i]);
                }catch(ignored){
                }
            }
        }
    }

    throw last;
}

// ---------------------------------------------------------------------
// SRV
// ---------------------------------------------------------------------

/** One SRV query against the configured nameservers.
 *  @return a Seq (possibly empty) when a nameserver ANSWERED, or null when
 *          none of them did (timeout, dropped datagram, unparseable reply).
 *  ArcDns' single-argument getSrvRecords() collapses both cases into an empty
 *  list - see the explanation at the top of this file. */
function srvQueryOnce(name){
    let nameservers = null;
    try{
        nameservers = ArcDns.getNameservers().toArray();
    }catch(e){
        return null;
    }
    if(nameservers === null || nameservers.length === 0) return null;

    for(let i = 0; i < nameservers.length; i++){
        try{
            // the two-argument overload throws instead of pretending "no record"
            return ArcDns.getSrvRecords(name, nameservers[i]);
        }catch(e){
            // timeout or broken reply - try the next nameserver
        }
    }
    return null;
}

/** Reliable SRV query: gated so a burst of pings cannot drown the resolver,
 *  and retried when nothing answered at all.
 *  @return a Seq (empty = the record really does not exist) or null (unknown). */
function srvQuery(name, gateWaitMs){
    const waitMs = (typeof gateWaitMs === "undefined" || gateWaitMs === null) ? SRV_GATE_WAIT_MS : gateWaitMs;

    for(let attempt = 0; attempt < SRV_ATTEMPTS; attempt++){
        let acquired = false;
        try{
            // Bounded wait: never park a ping behind a whole community-list
            // refresh. If the gate is saturated, give up now and let the caller
            // fall through to the remembered route / plain ping.
            acquired = srvGate.tryAcquire(waitMs, java.util.concurrent.TimeUnit.MILLISECONDS);
            if(!acquired) return null;

            const records = srvQueryOnce(name);
            if(records !== null) return records;
        }catch(e){
            Log.debug("[SplitPort] SRV query for @ failed: @", name, errText(e));
        }finally{
            if(acquired){
                try{
                    srvGate.release();
                }catch(ignored){
                }
            }
        }

        if(attempt + 1 < SRV_ATTEMPTS){
            try{
                java.lang.Thread.sleep(SRV_RETRY_DELAY * (attempt + 1));
            }catch(ignored){
            }
        }
    }

    Log.debug("[SplitPort] no DNS answer for @ after @ attempt(s) - treating the lookup as failed, not as 'no record'",
        name, "" + SRV_ATTEMPTS);
    return null;
}

/** @return {tcp, udp, definitive} - tcp/udp are Seq<SRVRecord> or null when the
 *  record type has no record; `definitive` is false when DNS never answered, so
 *  an empty result must not be trusted. Records are already sorted by priority
 *  then weight by ArcDns. */
function querySrv(address, gateWaitMs){
    let udp = srvQuery(UDP_SRV_PREFIX + address, gateWaitMs);
    let tcp = srvQuery(TCP_SRV_PREFIX + address, gateWaitMs);

    let hasUdp = udp !== null && udp.size > 0;
    let hasTcp = tcp !== null && tcp.size > 0;

    // A server that publishes one protocol almost always publishes the other.
    // When one half came back with records and the other did not, the missing
    // half is far more likely to be a lost UDP answer than a server that really
    // publishes only one protocol - so ask again before trusting it.
    //
    // This is what makes a split-port server reliable: if the _udp query is the
    // one that got dropped, trusting the empty result would push the mod into
    // vanilla's "_tcp port serves UDP too" ping, which sends the UDP discovery
    // datagram to the *TCP* port and can never answer.
    if(hasTcp && !hasUdp){
        const retryUdp = srvQuery(UDP_SRV_PREFIX + address, gateWaitMs);
        if(retryUdp !== null && retryUdp.size > 0){
            udp = retryUdp;
            hasUdp = true;
            Log.debug("[SplitPort] @ answered the first _udp lookup with nothing, second one had records", address);
        }
    }

    if(hasUdp && tcp !== null && tcp.size === 0){
        const retryTcp = srvQuery(TCP_SRV_PREFIX + address, gateWaitMs);
        if(retryTcp !== null && retryTcp.size > 0){
            tcp = retryTcp;
            hasTcp = true;
            Log.debug("[SplitPort] @ answered the first _tcp lookup with nothing, second one had records", address);
        }
    }

    return {
        tcp: hasTcp ? tcp : null,
        udp: hasUdp ? udp : null,
        definitive: udp !== null && tcp !== null
    };
}

function targetsDiffer(a, b){
    if(a === null || b === null) return false;
    try{
        return ("" + a).toLowerCase() !== ("" + b).toLowerCase();
    }catch(ignored){
        return false;
    }
}

/** Resolve the SRV records of a server into a reachable host + both ports.
 *  Returns a Host, or null when nothing answered (caller falls back). */
function pingThroughSrv(address, port, srv){
    // The TCP port: from the _tcp record if it exists, otherwise the port the
    // user asked for (the server's NAT usually keeps the default for TCP).
    let tcpPort = port;
    let tcpTarget = null;
    if(srv.tcp !== null){
        const record = srv.tcp.first();
        tcpPort = record.port;
        tcpTarget = stripDot(record.target);
    }

    // Preferred path: the _udp record tells us which port discovery lives on.
    if(srv.udp !== null){
        const udpRecords = srv.udp.toArray();
        for(let i = 0; i < udpRecords.length; i++){
            let record = udpRecords[i];
            let target = stripDot(record.target);
            if(isNoService(target)){
                Log.warn("[SplitPort] _udp record #@ for @ is a no-service record", "" + i, address);
                continue;
            }

            try{
                let host = pingRetry(target, record.port);

                // TCP and UDP must share one host in Arc's Client.connect, so
                // when both records point somewhere else, prefer the _tcp
                // target (it is authoritative for the game connection).
                let connectHost = host.address;
                if(!isNoService(tcpTarget) && !targetsDiffer(tcpTarget, target)){
                    // same host: reuse the IP that actually answered the ping
                    connectHost = host.address;
                }else if(!isNoService(tcpTarget)){
                    connectHost = tcpTarget;
                    Log.warn("[SplitPort] @: _tcp target '@' differs from _udp target '@'. " +
                        "Arc can only use one address for both protocols; using the _tcp target.",
                        address, tcpTarget, target);
                }

                host.port = tcpPort;
                putRoute(host.address, tcpPort, connectHost, tcpPort, record.port);
                putRoute(address, port, connectHost, tcpPort, record.port);
                // also remember the pair under "domain:tcpPort", which is what a
                // favourite or a reconnect may ask about later
                putRoute(address, tcpPort, connectHost, tcpPort, record.port);
                Log.info("[SplitPort] SRV @ -> @ (TCP @, UDP @)", address, connectHost, "" + tcpPort, "" + record.port);
                return host;
            }catch(e){
                Log.debug("[SplitPort] SRV UDP target @:@ did not answer (@)",
                    target, "" + record.port, errText(e));
            }
        }
    }

    // Only _tcp records: this is exactly vanilla's SRV fallback - the record's
    // port serves both protocols.
    if(srv.tcp !== null){
        const tcpRecords = srv.tcp.toArray();
        for(let i = 0; i < tcpRecords.length; i++){
            let record = tcpRecords[i];
            let target = stripDot(record.target);
            if(isNoService(target)) continue;

            try{
                let host = pingRetry(target, record.port);
                host.port = record.port;
                putRoute(host.address, record.port, host.address, record.port, record.port);
                putRoute(address, record.port, host.address, record.port, record.port);
                putRoute(address, port, host.address, record.port, record.port);
                Log.info("[SplitPort] SRV @ -> @ (single port @)", address, target, "" + record.port);
                return host;
            }catch(e){
                Log.debug("[SplitPort] SRV TCP target @:@ did not answer (@)",
                    target, "" + record.port, errText(e));
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------
// NetProvider
// ---------------------------------------------------------------------

/** Ping a server whose two ports were learned earlier.
 *  JoinDialog stores a favourite as "<resolved ip>:<tcp port>" and reconnects
 *  with the same pair, so without this the UDP port can never be found again
 *  and the entry shows as "not responding" even though the server is up. */
function pingKnownRoute(address, port, known){
    let host = null;
    let error = null;

    // The remembered host is what answered last time (an IP, or the SRV target).
    // Try it FIRST: the entry shown by the game may be a pure-SRV domain with no
    // A record at all, where pinging the displayed name can only ever fail.
    if(!isNoService(known.host)){
        try{
            host = pingRetry(known.host, known.udp);
        }catch(e){
            error = e;
        }
    }

    if(host === null){
        try{
            host = pingRetry(address, known.udp);
        }catch(e){
            error = e;
        }
    }

    if(host === null){
        Log.debug("[SplitPort] remembered UDP port @ for @:@ did not answer (@), probing normally",
            "" + known.udp, address, "" + port, errText(error));
        return null;
    }

    host.port = known.tcp;
    putRoute(host.address, known.tcp, known.host, known.tcp, known.udp);
    putRoute(address, known.tcp, known.host, known.tcp, known.udp);
    putRoute(address, port, known.host, known.tcp, known.udp);
    Log.info("[SplitPort] remembered route @:@ -> @ (TCP @, UDP @)",
        address, "" + port, known.host, "" + known.tcp, "" + known.udp);
    return host;
}

function buildProvider(){
    return extend(ArcNetProvider, {
        /** Vanilla pings `address:port` over UDP and, only if that fails,
         *  tries the _mindustry._tcp SRV records. This mod asks DNS first so
         *  that a separate UDP port can be used, then falls back to a route it
         *  learned earlier, and finally to vanilla's single-port ping.
         *
         *  Whatever happens, exactly one of valid/invalid is called: an
         *  exception escaping here would be swallowed by Net's ping executor
         *  and the server entry would spin forever. */
        pingHost: function(address, port, valid, invalid){
            try{
                const checkSrv = port === Vars.port && !isIpAddress(address);

                // A route learned earlier for exactly this address:port. When
                // one exists, DNS only gets a brief chance: a favourite that was
                // already resolved must not queue behind the SRV gate while
                // JoinDialog refreshes the community list. If DNS answers in
                // time it stays authoritative; otherwise the route is used.
                const known = getRoute(address, port);
                const hasKnown = known !== null && known.udp !== port;
                let srvAuthoritative = false;

                // 1) SRV first - that is the whole point of this mod.
                if(checkSrv){
                    let srv = null;
                    try{
                        srv = querySrv(address, hasKnown ? SRV_GATE_WAIT_KNOWN_MS : SRV_GATE_WAIT_MS);
                    }catch(e){
                        Log.debug("[SplitPort] SRV lookup for @ failed: @", address, errText(e));
                    }

                    if(srv !== null){
                        if(srv.tcp !== null || srv.udp !== null){
                            const host = pingThroughSrv(address, port, srv);
                            if(host !== null){
                                Core.app.post(run(() => valid.get(host)));
                                return;
                            }
                            Log.debug("[SplitPort] no SRV target for @ answered, probing directly", address);
                        }else if(srv.definitive){
                            // DNS answered "this server has no SRV records", so a
                            // remembered route must not override the plain ping
                            srvAuthoritative = true;
                        }
                    }
                }

                // 2) A route learned earlier for exactly this address:port
                //    (favourite saved as "ip:tcpPort", reconnect, DNS outage).
                if(!srvAuthoritative && hasKnown){
                    const host = pingKnownRoute(address, port, known);
                    if(host !== null){
                        Core.app.post(run(() => valid.get(host)));
                        return;
                    }
                }

                // 3) vanilla behaviour: one port for both protocols.
                //    Reaching this means the ping answered on `port`, so this
                //    result is authoritative and replaces any remembered route
                //    (a split-port server that answers on a single port is no
                //    longer split).
                const host = rawPing(address, port);
                host.port = port;
                putRoute(host.address, port, host.address, port, port);
                putRoute(address, port, host.address, port, port);
                Core.app.post(run(() => valid.get(host)));
            }catch(e){
                // A timed-out ping is the NORMAL outcome for most community
                // servers and vanilla logs nothing for it. Logging an error here
                // emitted one line per non-answering server - hundreds per
                // refresh - which flooded the console/log and buried chat and
                // join/leave messages. Keep it at debug so it is only visible
                // when debug logging is explicitly enabled.
                Log.debug("[SplitPort] ping probe for @:@ failed: @", address, "" + port, errText(e));
                try{
                    Core.app.post(run(() => invalid.get(asException(e))));
                }catch(ignored){
                }
            }
        },

        /** Mirrors ArcNetProvider.connectClient, but with the UDP port that
         *  was learned from DNS instead of reusing the TCP port. */
        connectClient: function(ip, port, success){
            Threads.daemon(run(() => {
                try{
                    let route = getRoute(ip, port);
                    if(route === null){
                        route = resolveRoute(ip, port);
                        if(route !== null){
                            putRoute(ip, port, route.host, route.tcp, route.udp);
                            // remember the pair under the TCP port as well, so a
                            // later favourite or reconnect finds it immediately
                            putRoute(ip, route.tcp, route.host, route.tcp, route.udp);
                        }
                    }

                    const host = route !== null ? route.host : ip;
                    const tcpPort = route !== null ? route.tcp : port;
                    const udpPort = route !== null ? route.udp : port;

                    Log.info("[SplitPort] connecting @ (as given @:@) - TCP @ / UDP @",
                        host, ip, "" + port, "" + tcpPort, "" + udpPort);

                    const client = clientField.get(provider);
                    client.stop();

                    Threads.daemon("Net Client", run(() => {
                        try{
                            client.run();
                        }catch(e){
                            const cause = asThrowable(e);
                            if(!(cause instanceof java.nio.channels.ClosedSelectorException)){
                                Vars.net.handleException(cause);
                            }
                        }
                    }));

                    client.connect(CONNECT_TIMEOUT, host, tcpPort, udpPort);
                    success.run();
                }catch(e){
                    if(Vars.netClient !== null && Vars.netClient !== undefined && Vars.netClient.isConnecting()){
                        Vars.net.handleException(asThrowable(e));
                    }else{
                        Log.err("[SplitPort] connect failed: @", errText(e));
                    }
                }
            }));
        }
    });
}

/** Used when the game asks to connect without having learned a route from a
 *  previous ping (direct connect, favourites that were never pinged, a domain
 *  with no A record at all, ...). */
function resolveRoute(ip, port){
    if(!isIpAddress(ip) && port === Vars.port){
        let srv = null;
        try{
            srv = querySrv(ip);
        }catch(e){
            Log.debug("[SplitPort] SRV lookup for @ failed: @", ip, errText(e));
        }

        if(srv !== null && (srv.tcp !== null || srv.udp !== null)){
            let host = null, tcpPort = port, udpPort = port;

            if(srv.tcp !== null){
                tcpPort = srv.tcp.first().port;
                host = stripDot(srv.tcp.first().target);
            }
            if(srv.udp !== null){
                udpPort = srv.udp.first().port;
                if(host === null) host = stripDot(srv.udp.first().target);
            }

            if(!isNoService(host)){
                Log.info("[SplitPort] SRV @ -> @ (TCP @, UDP @)", ip, host, "" + tcpPort, "" + udpPort);
                return {host: host, tcp: tcpPort, udp: udpPort};
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------
// installing the provider
// ---------------------------------------------------------------------

/** Rhino exposes an imported Java class as a NativeJavaClass, on which
 *  java.lang.Class' own methods (getDeclaredField, getSuperclass, ...) are not
 *  reachable. Class.forName() returns a plain Class wrapper that does support
 *  them, so all reflection goes through here. */
function javaClass(name){
    return java.lang.Class.forName(name);
}

function findField(cls, name){
    try{
        const field = cls.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }catch(e){
        return null;
    }
}

/** Net stores its packet handlers in private maps. They are registered by
 *  NetClient/NetServer long before mod scripts run, so a freshly created Net
 *  would be deaf. Read the old maps and re-register them through the public
 *  API - reading a private field needs no final-field mutation. */
function copyListeners(from, to){
    let copied = 0;

    const netClass = javaClass("mindustry.net.Net");
    const clientMapField = findField(netClass, "clientListeners");
    const serverMapField = findField(netClass, "serverListeners");

    if(clientMapField === null || serverMapField === null){
        throw new java.lang.RuntimeException(
            "cannot find Net.clientListeners/serverListeners - unsupported game version");
    }

    const clientMap = clientMapField.get(from);
    const serverMap = serverMapField.get(from);

    // NOTE: Seq.get(int) is avoided on purpose - inside Rhino-compiled loops it
    // has been observed to keep returning element 0 (optimizer bug), while
    // toArray()/items[] are reliable. Map.keys() hands back public Keys/Values
    // wrappers whose toSeq() also avoids the package-private iterator fields.
    const clientKeys = clientMap.keys().toSeq().toArray();
    for(let i = 0; i < clientKeys.length; i++){
        let key = clientKeys[i];
        to.handleClient(key, clientMap.get(key));
        copied++;
    }

    const serverKeys = serverMap.keys().toSeq().toArray();
    for(let i = 0; i < serverKeys.length; i++){
        let key = serverKeys[i];
        to.handleServer(key, serverMap.get(key));
        copied++;
    }

    return copied;
}

function locateClientField(){
    let cls = javaClass("mindustry.net.ArcNetProvider");
    while(cls !== null && cls !== undefined && clientField === null){
        clientField = findField(cls, "client");
        if(clientField === null) cls = cls.getSuperclass();
    }
    if(clientField === null){
        throw new java.lang.RuntimeException("cannot find ArcNetProvider.client - unsupported game version");
    }
}

function install(){
    if(installed) return;

    if(Vars.steam){
        Log.info("[SplitPort] Steam build detected - Steam networking has no ports, leaving net untouched.");
        return;
    }

    const original = Vars.net;
    if(original === null || original === undefined){
        throw new java.lang.RuntimeException("Vars.net is not initialised yet");
    }

    // Resolved before the provider is built so connectClient can use it.
    locateClientField();

    // Bring back the split-port routes learned in previous sessions before any
    // ping or join can ask for them.
    loadRoutes();

    provider = buildProvider();

    const replacement = new Net(provider);
    const copied = copyListeners(original, replacement);

    // Net is read through the static Vars.net everywhere in the game
    // (import static mindustry.Vars.*), so swapping the reference is enough
    // and nothing keeps using the old instance.
    Vars.net = replacement;
    installed = true;

    Log.info("[SplitPort] installed: @ packet handler(s) carried over, _mindustry._tcp/_udp split ports active.", "" + copied);
}

// ClientLoadEvent fires on the main thread after every module (including
// NetClient/NetServer) has been constructed and initialised.
Events.on(ClientLoadEvent, cons(e => {
    try{
        install();
    }catch(e){
        Log.err("[SplitPort] failed to install; the game will keep using the vanilla net provider.");
        Log.err(asThrowable(e));
    }
}));
