"use strict";

// SPDX-License-Identifier: GPL-3.0-only
// SplitPort (SRV) - SRV discovery and UDP probing, loaded with
// require("lib/srv").
//
// Order inside this file: constants, the raw UDP discovery ping, the SRV
// queries (gated + retried), turning SRV records into a reachable Host,
// the remembered-route probe, and resolveRoute for a connect that never
// went through a ping.

const util = require("lib/util");
const dns = require("lib/dns");
const routes = require("lib/routes");

const errText = util.errText;
const isIpAddress = util.isIpAddress;
const isNoService = util.isNoService;
const stripDot = util.stripDot;
const putRoute = routes.putRoute;
const dnsQueryOnce = dns.dnsQueryOnce;
const toSrvSeq = dns.toSrvSeq;

const TCP_SRV_PREFIX = "_mindustry._tcp.";
const UDP_SRV_PREFIX = "_mindustry._udp.";

/** How long to wait for a discovery reply, matching vanilla. */
const PING_TIMEOUT = 2000;

/** How many SRV queries may be in flight at once. The local resolver starts
 *  dropping answers somewhere above ~16 concurrent lookups (the measurements
 *  are in docs/INTERNALS.md section 3.1), and 8 measured a 0% loss rate. */
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

/** One SRV query against the configured nameservers.
 *  @return a Seq (possibly empty) when a nameserver ANSWERED, or null when
 *          none of them did (timeout, dropped datagram, unparseable reply).
 *  The distinction matters: an empty answer is authoritative ("this name has
 *  no SRV record"), a missing one is not. ArcDns conflates the two and cannot
 *  walk a CNAME either, which is why the query goes through the DNS client
 *  above instead. */
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
            let answer = dnsQueryOnce(name, nameservers[i]);
            if(answer !== null) return toSrvSeq(answer.records);
        }catch(e){
            // malformed answer - try the next nameserver
            Log.debug("[SplitPort] DNS answer for @ from @ was unusable: @",
                name, "" + nameservers[i], errText(e));
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

module.exports = {
    // the two gate waits are exported because the ping entry point in lib/net
    // picks between them (known route vs. not)
    SRV_GATE_WAIT_MS: SRV_GATE_WAIT_MS,
    SRV_GATE_WAIT_KNOWN_MS: SRV_GATE_WAIT_KNOWN_MS,

    rawPing: rawPing,

    querySrv: querySrv,

    pingThroughSrv: pingThroughSrv,

    pingKnownRoute: pingKnownRoute,

    resolveRoute: resolveRoute

};
