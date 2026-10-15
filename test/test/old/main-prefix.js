// =====================================================================
// Split Port (SRV) - a client-side-only Mindustry mod
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

/** "address:port" -> "host|tcpPort|udpPort" for the current session.
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
    }catch(e){
        Log.warn("[SplitPort] could not store route for @: @", address, errText(e));
    }
}

/** @return {host, tcp, udp} or null. */
function getRoute(address, port){
    try{
        const value = routes.get(routeKey(address, port));
        if(value === null || value === undefined) return null;

        const s = "" + value;
        const first = s.indexOf("|");
        if(first < 0) return null;
        const second = s.indexOf("|", first + 1);
        if(second < 0) return null;

        return {
            host: s.substring(0, first),
            tcp: Number(s.substring(first + 1, second)),
            udp: Number(s.substring(second + 1))
        };
    }catch(e){
        return null;
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

// ---------------------------------------------------------------------
// SRV
// ---------------------------------------------------------------------

function srvQuery(name){
    try{
        return ArcDns.getSrvRecords(name);
    }catch(e){
        Log.warn("[SplitPort] SRV query for @ failed: @", name, errText(e));
        return null;
    }
}

/** @return {tcp: Seq<SRVRecord>|null, udp: Seq<SRVRecord>|null} or null when
 *  neither record type exists. Records are already sorted by
 *  priority then weight by ArcDns. */
function querySrv(address){
    const tcp = srvQuery(TCP_SRV_PREFIX + address);
    const udp = srvQuery(UDP_SRV_PREFIX + address);

    const hasTcp = tcp !== null && tcp.size > 0;
    const hasUdp = udp !== null && udp.size > 0;
    if(!hasTcp && !hasUdp) return null;

    return {tcp: hasTcp ? tcp : null, udp: hasUdp ? udp : null};
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
                let host = rawPing(target, record.port);

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
                Log.info("[SplitPort] SRV @ -> @ (TCP @, UDP @)", address, connectHost, "" + tcpPort, "" + record.port);
                return host;
            }catch(e){
                Log.warn("[SplitPort] SRV UDP target @:@ did not answer (@)",
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
                let host = rawPing(target, record.port);
                host.port = record.port;
                putRoute(host.address, record.port, host.address, record.port, record.port);
                putRoute(address, record.port, host.address, record.port, record.port);
                putRoute(address, port, host.address, record.port, record.port);
                Log.info("[SplitPort] SRV @ -> @ (single port @)", address, target, "" + record.port);
                return host;
            }catch(e){
                Log.warn("[SplitPort] SRV TCP target @:@ did not answer (@)",
                    target, "" + record.port, errText(e));
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------
// NetProvider
// ---------------------------------------------------------------------

function buildProvider(){
    return extend(ArcNetProvider, {
        /** Vanilla pings `address:port` over UDP and, only if that fails,
         *  tries the _mindustry._tcp SRV records. This mod asks DNS first so
         *  that a separate UDP port can be used, and keeps vanilla's direct
         *  ping as the fallback. */
        pingHost: function(address, port, valid, invalid){
            const checkSrv = port === Vars.port && !isIpAddress(address);

            if(checkSrv){
                let srv = null;
                try{
                    srv = querySrv(address);
                }catch(e){
                    Log.warn("[SplitPort] SRV lookup for @ failed: @", address, errText(e));
                }

                if(srv !== null){
                    const host = pingThroughSrv(address, port, srv);
                    if(host !== null){
                        Core.app.post(run(() => valid.get(host)));
                        return;
                    }
                    Log.info("[SplitPort] no SRV target for @ answered, using the vanilla ping", address);
                }
            }

            // vanilla behaviour: one port for both protocols
            try{
                const host = rawPing(address, port);
                host.port = port;
                // Make this authoritative so a stale SRV route cannot be used
                // by a later connect() that only knows the numeric IP.
                putRoute(host.address, port, host.address, port, port);
                putRoute(address, port, host.address, port, port);
                Core.app.post(run(() => valid.get(host)));
            }catch(e){
                Core.app.post(run(() => invalid.get(asException(e))));
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
            Log.warn("[SplitPort] SRV lookup for @ failed: @", ip, errText(e));
        }

        if(srv !== null){
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
