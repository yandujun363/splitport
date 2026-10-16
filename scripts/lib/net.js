"use strict";

// SPDX-License-Identifier: GPL-3.0-only
// SplitPort (SRV) - the network layer, loaded with require("lib/net").
//
// Holds everything that talks to the game: the ArcNetProvider subclass, the
// Net subclass that actually overrides pingHost, the ping/connect entry
// points, and install() itself.

const util = require("lib/util");
const routes = require("lib/routes");
const srv = require("lib/srv");

const errText = util.errText;
const asThrowable = util.asThrowable;
const asException = util.asException;
const isIpAddress = util.isIpAddress;
const getRoute = routes.getRoute;
const putRoute = routes.putRoute;
const forgetRoute = routes.forgetRoute;
const loadRoutes = routes.loadRoutes;
const SRV_GATE_WAIT_MS = srv.SRV_GATE_WAIT_MS;
const SRV_GATE_WAIT_KNOWN_MS = srv.SRV_GATE_WAIT_KNOWN_MS;
const rawPing = srv.rawPing;
const querySrv = srv.querySrv;
const pingThroughSrv = srv.pingThroughSrv;
const pingKnownRoute = srv.pingKnownRoute;
const resolveRoute = srv.resolveRoute;

/** connect timeout, matching ArcNetProvider.connectClient. */
const CONNECT_TIMEOUT = 5000;

let installed = false;
let clientField = null;
let provider = null;

function buildProvider(){
    return extend(ArcNetProvider, {
        /** The provider hook only matters on builds whose Net still delegates
         *  pings to it. MindustryX replaced Net.pingHost with its own
         *  PingService, so what actually runs there is the Net subclass built in
         *  install(). Both paths call doPing(). */
        pingHost: function(address, port, valid, invalid){
            doPing(address, port, valid, invalid);
        },

        connectClient: function(ip, port, success){
            doConnect(ip, port, success);
        }
    });
}

/** Entry point for every ping. Net.pingHost runs on its caller's thread, which
 *  is the render thread whenever the game does not hand the work to a pool of
 *  its own, so the work always moves off it. */
function doPing(address, port, valid, invalid){
    try{
        Threads.daemon(run(() => doPingNow(address, port, valid, invalid)));
    }catch(e){
        // no thread available: blocking is still better than never answering
        doPingNow(address, port, valid, invalid);
    }
}

/** Vanilla pings address:port over UDP and, only if that fails, tries the
 *  _mindustry._tcp SRV records. This mod asks DNS first so that a separate UDP
 *  port can be used, then falls back to a route it learned earlier, and
 *  finally to vanilla's single-port ping.
 *
 *  Whatever happens, exactly one of valid/invalid is called: an exception
 *  escaping here is swallowed by Net's ping executor on vanilla and by
 *  PingService on MindustryX, and the server entry then spins on
 *  "refreshing..." forever with nothing in the log to explain it. */
function doPingNow(address, port, valid, invalid){
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
}

/** Connect through the route DNS describes rather than through the route the
 *  last session remembered; a remembered route is only used when DNS gives
 *  nothing. */
function doConnect(ip, port, success){
    Threads.daemon(run(() => {
        try{
            let route = null;

            // A domain on the default port: DNS is authoritative. Resolving
            // here, and not only at ping time, is what stops a remembered route
            // from pinning the client to a NAT port that no longer exists - the
            // entry may never have been pinged, or the ping may itself have
            // fallen back to that very route.
            if(!isIpAddress(ip) && port === Vars.port){
                route = resolveRoute(ip, port);
            }

            if(route === null) route = getRoute(ip, port);
            if(route === null) route = resolveRoute(ip, port);

            const host = route !== null ? route.host : ip;
            const tcpPort = route !== null ? route.tcp : port;
            const udpPort = route !== null ? route.udp : port;

            if(route !== null){
                putRoute(ip, port, route.host, route.tcp, route.udp);
                // remember the pair under the TCP port as well, so a later
                // favourite or reconnect finds it immediately
                putRoute(ip, route.tcp, route.host, route.tcp, route.udp);
            }

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
            // The route that was just used points at a port that is gone (the
            // NAT mapping changed). Forget it, so that the next attempt
            // re-resolves through DNS instead of timing out the same way again.
            forgetRoute(ip, port);
            if(Vars.netClient !== null && Vars.netClient !== undefined && Vars.netClient.isConnecting()){
                Vars.net.handleException(asThrowable(e));
            }else{
                Log.err("[SplitPort] connect failed: @", errText(e));
            }
        }
    }));
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

    // MindustryX replaces Net.pingHost with its own PingService
    // (patches/client/0061), so a provider-level pingHost is never reached
    // there and the entry spins on "refreshing..." no matter what the mod
    // does. Subclassing Net and overriding pingHost itself keeps the SRV logic
    // in charge on every build; the provider override stays as the path used
    // by builds that still delegate pings to the provider.
    //
    // Best-effort: if Net cannot be extended (made final, extra constructor
    // argument, ... in some future build) the mod falls back to a plain Net,
    // which is exactly what it did before.
    let replacement = null;
    try{
        replacement = extend(Net, provider, {
            pingHost: function(address, port, valid, invalid){
                doPing(address, port, valid, invalid);
            }
        });
    }catch(e){
        Log.warn("[SplitPort] cannot subclass Net (@) - pings are only intercepted on builds that delegate them to the net provider.",
            errText(e));
        replacement = new Net(provider);
    }

    const copied = copyListeners(original, replacement);

    // Net is read through the static Vars.net everywhere in the game
    // (import static mindustry.Vars.*), so swapping the reference is enough
    // and nothing keeps using the old instance.
    Vars.net = replacement;
    installed = true;

    Log.info("[SplitPort] installed: @ packet handler(s) carried over, _mindustry._tcp/_udp split ports active.", "" + copied);
}

module.exports = {

    install: install

};
