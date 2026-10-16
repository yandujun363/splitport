"use strict";

// SPDX-License-Identifier: GPL-3.0-only
// SplitPort (SRV) - the table of routes learned from DNS, loaded with
// require("lib/routes"). It is persisted in Core.settings so that
// favourites stored as "ip:tcpPort" survive a restart.

const util = require("lib/util");
const errText = util.errText;

/** Where learned routes are remembered across restarts. */
const ROUTES_SETTING = "splitport-routes";
const MAX_PERSISTED_ROUTES = 128;

/** "address:port" -> "host|tcpPort|udpPort".
 *  A ConcurrentHashMap is used because this map is written from the ping
 *  thread pool and read from the connect thread. Keys and values are forced
 *  to real java.lang.String instances so that equals()/hashCode() behave. */
const routes = new java.util.concurrent.ConcurrentHashMap();

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

/** Drop a remembered route. Called when a connect through it timed out: the
 *  external NAT port has almost certainly changed, and pinning the entry to
 *  the old one would make every later attempt fail the same way. */
function forgetRoute(address, port){
    try{
        const removed = routes.remove(routeKey(address, port));
        if(removed !== null && removed !== undefined) saveRoutes();
    }catch(e){
        Log.debug("[SplitPort] could not forget route @:@: @", address, "" + port, errText(e));
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

module.exports = {

    putRoute: putRoute,

    getRoute: getRoute,

    forgetRoute: forgetRoute,

    loadRoutes: loadRoutes,

    saveRoutes: saveRoutes

};
