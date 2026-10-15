// Split Port (SRV) - client-side mod
//
// Mindustry normally uses the SAME port for TCP and UDP:
//   ArcNetProvider.hostServer : server.bind(port, port)
//   ArcNetProvider.connectClient : client.connect(5000, ip, port, port)
//
// Arc's networking layer actually supports two different ports, so this mod
// replaces the active NetProvider with a subclass of ArcNetProvider that:
//   1. on ping, resolves BOTH "_mindustry._tcp.<address>" and
//      "_mindustry._udp.<address>" SRV records;
//   2. pings the UDP port (that is the only protocol the ping can use),
//      remembers the UDP port, and reports the TCP port as the host's port;
//   3. on connect, passes the TCP and UDP port separately to Client.connect.
//
// The game source is not modified: the provider is swapped at runtime.

// "ip:tcpPort" -> udpPort, learned from SRV (and persisted in settings)
const udpPorts = {};
// Cached reflective handle on ArcNetProvider.client (package-private field)
let clientField = null;

// NOTE: no regular expressions here on purpose. Rhino's NativeRegExp caches
// compiled regexp bytecode and is not safe when executed from a non-main thread
// (it throws "FAILED ASSERTION: invalid bytecode" from executeREBytecode).
// IPv4/IPv6 detection is therefore done with plain JS string operations only.
function isIpAddress(address){
    if(address === null || address === undefined) return false;

    const s = "" + address;
    if(s.indexOf(":") !== -1) return true; // IPv6 literal

    let dots = 0, partLen = 0;
    for(let i = 0; i < s.length; i++){
        const c = s.charCodeAt(i);
        if(c === 46){ // '.'
            if(partLen === 0 || partLen > 3) return false;
            dots++;
            partLen = 0;
        }else if(c >= 48 && c <= 57){ // '0'-'9'
            partLen++;
        }else{
            return false;
        }
    }
    return dots === 3 && partLen > 0 && partLen <= 3;
}

// Rhino surfaces a caught Java exception as a JS Error object (name "JavaException")
// that is NOT a Throwable, so it cannot be passed to Java methods like
// Net.handleException(Throwable) directly. The original exception is exposed as
// .javaException (WrappedException under .rhinoException).
function asThrowable(e){
    try{
        if(e !== null && e !== undefined){
            if(e.javaException !== undefined && e.javaException !== null) return e.javaException;
            if(e.rhinoException !== undefined && e.rhinoException !== null) return e.rhinoException;
        }
    }catch(ignored){
    }
    return new java.lang.RuntimeException(errorText(e));
}

// Safe message extraction: works for both JS errors (.message) and Java exceptions.
function errorText(e){
    try{
        if(e === null || e === undefined) return "unknown error";
        if(e.message !== undefined && e.message !== null) return "" + e.message;
        return "" + e;
    }catch(ignored){
        return "unknown error";
    }
}

// SRV targets from ArcDns normally have no trailing dot, but be defensive:
// "host.example.com." must become "host.example.com".
function stripDot(host){
    try{
        if(host !== null && host !== undefined){
            const s = "" + host;
            if(s.length > 0 && s.charAt(s.length - 1) === "."){
                return s.substring(0, s.length - 1);
            }
        }
    }catch(ignored){
    }
    return host;
}

// Raw server-info ping: send the {-2, 1} discovery datagram over UDP and parse the reply.
function rawPing(address, port){
    const socket = new Packages.java.net.DatagramSocket();
    try{
        const start = Time.millis();

        const request = java.nio.ByteBuffer.allocate(2).put(-2).put(1).array();
        socket.send(new Packages.java.net.DatagramPacket(request, request.length,
            Packages.java.net.InetAddress.getByName(address), port));
        socket.setSoTimeout(2000);

        const data = java.nio.ByteBuffer.allocate(512).array();
        const packet = new Packages.java.net.DatagramPacket(data, data.length);
        socket.receive(packet);

        const buffer = java.nio.ByteBuffer.wrap(packet.getData(), 0, packet.getLength());
        const host = NetworkIO.readServerData(Time.timeSinceMillis(start), packet.getAddress().getHostAddress(), buffer);
        host.port = port;
        return host;
    }finally{
        socket.close();
    }
}

// Returns {tcpPort, udpPort, target} or null if no SRV records exist.
function lookupSrv(address, port){
    const tcp = ArcDns.getSrvRecords("_mindustry._tcp." + address);
    const udp = ArcDns.getSrvRecords("_mindustry._udp." + address);
    const t = tcp.size > 0 ? tcp.first() : null;
    const u = udp.size > 0 ? udp.first() : null;

    if(t === null && u === null) return null;

    return {
        tcpPort: t !== null ? t.port : port,
        // no _udp record -> assume the TCP port also serves UDP (vanilla behaviour)
        udpPort: u !== null ? u.port : (t !== null ? t.port : port),
        target: u !== null ? u.target : (t !== null ? t.target : address)
    };
}

function loadPorts(){
    try{
        const saved = Core.settings.getString("splitport-map", "");
        if(saved && saved.length > 0){
            const parsed = JSON.parse(saved);
            for(var key in parsed){
                udpPorts[key] = parsed[key];
            }
        }
    }catch(e){
        Log.warn("[SplitPort] could not load saved port map: @", errorText(e));
    }
}

function savePorts(){
    try{
        Core.settings.put("splitport-map", JSON.stringify(udpPorts));
    }catch(e){
        Log.warn("[SplitPort] could not save port map: @", errorText(e));
    }
}

function install(){
    if(Vars.steam){
        Log.info("[SplitPort] Steam build detected; leaving the net provider untouched.");
        return;
    }

    loadPorts();

    const provider = extend(ArcNetProvider, {
        pingHost: function(address, port, valid, invalid){
            // 1) Re-use a previously learned UDP port (e.g. a saved favourite that is
            //    stored as a bare IP:port, where SRV can no longer be queried).
            const known = udpPorts[address + ":" + port];
            if(known !== undefined && known !== port){
                try{
                    const host = rawPing(address, known);
                    host.port = port;
                    Core.app.post(run(() => valid.get(host)));
                    return;
                }catch(e){
                    // fall through to the normal lookup
                }
            }

            // 2) Domain + default port: ask DNS for both protocol records.
            let srv = null;
            if(port === Vars.port && !isIpAddress(address)){
                try{
                    srv = lookupSrv(address, port);
                }catch(e){
                    Log.warn("[SplitPort] SRV lookup failed for @: @", address, errorText(e));
                }
            }

            if(srv !== null && srv.target !== "."){
                try{
                    // The ping is UDP, so it must target the UDP port.
                    const host = rawPing(stripDot(srv.target), srv.udpPort);
                    udpPorts[host.address + ":" + srv.tcpPort] = srv.udpPort;
                    savePorts();
                    Log.info("[SplitPort] @ -> @ / TCP @ / UDP @", address, srv.target, srv.tcpPort, srv.udpPort);
                    // The rest of the client (join dialog, Server entry) consumes host.port
                    // as the port to connect on, which must be the TCP port.
                    host.port = srv.tcpPort;
                    Core.app.post(run(() => valid.get(host)));
                    return;
                }catch(e){
                    Log.warn("[SplitPort] SRV target @:@ unreachable (@), trying direct ping.",
                        srv.target, srv.udpPort, errorText(e));
                }
            }

            // 3) No SRV / SRV failed: vanilla single-port behaviour.
            try{
                const host = rawPing(address, port);
                Core.app.post(run(() => valid.get(host)));
            }catch(e){
                Core.app.post(run(() => invalid.get(e)));
            }
        },

        connectClient: function(ip, port, success){
            const client = clientField.get(provider);

            // Mirrors ArcNetProvider.connectClient, but with two distinct ports.
            // SRV resolution also happens here (not only during ping): a pure-SRV
            // domain has no A record, and the join dialog may call connect() without
            // a completed ping, passing the bare domain straight through.
            Threads.daemon(run(() => {
                try{
                    let target = ip;
                    let tcpPort = port;
                    let udpPort = udpPorts[ip + ":" + port] || port;

                    if(!isIpAddress(ip)){
                        let srv = null;
                        if(port === Vars.port){
                            try{
                                srv = lookupSrv(ip, port);
                            }catch(e){
                                Log.warn("[SplitPort] SRV lookup failed for @: @", ip, errorText(e));
                            }
                        }

                        if(srv !== null && srv.target !== "."){
                            target = stripDot(srv.target);
                            tcpPort = srv.tcpPort;
                            udpPort = srv.udpPort;
                            udpPorts[ip + ":" + tcpPort] = udpPort;
                            savePorts();
                        }else{
                            // no SRV: let Arc resolve the hostname itself
                            target = stripDot(ip);
                        }
                    }

                    Log.info("[SplitPort] connecting @ - TCP @ / UDP @", target, tcpPort, udpPort);

                    client.stop();

                    Threads.daemon("Net Client", run(() => {
                        try{
                            client.run();
                        }catch(e){
                            const cause = asThrowable(e);
                            if(!(cause instanceof Packages.java.nio.channels.ClosedSelectorException)){
                                Vars.net.handleException(cause);
                            }
                        }
                    }));

                    client.connect(5000, target, tcpPort, udpPort);
                    success.run();
                }catch(e){
                    if(Vars.netClient.isConnecting()){
                        Vars.net.handleException(asThrowable(e));
                    }
                }
            }));
        }
    });

    // Locate ArcNetProvider.client reflectively (it is package-private).
    let cls = provider.getClass();
    while(cls !== null && clientField === null){
        try{
            clientField = cls.getDeclaredField("client");
        }catch(e){
            cls = cls.getSuperclass();
        }
    }
    if(clientField === null) throw new Error("could not locate ArcNetProvider.client");
    clientField.setAccessible(true);

    // Swap in a fresh Net bound to our provider. NetServer/NetClient read Vars.net
    // dynamically, and the old provider is simply unused afterwards.
    Vars.net = new Net(provider);

    Log.info("[SplitPort] installed: _mindustry._tcp/_udp dual-port SRV lookup active.");
}

Events.on(ClientLoadEvent, cons(e => {
    try{
        install();
    }catch(e){
        Log.err("[SplitPort] failed to install");
        Log.err(asThrowable(e));
    }
}));
