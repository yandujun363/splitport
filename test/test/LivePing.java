import arc.*;
import arc.mock.*;
import arc.struct.*;
import arc.util.*;

import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.net.ArcNetProvider;
import mindustry.net.Host;
import mindustry.net.Net;
import mindustry.net.Packets.Connect;

import rhino.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.concurrent.*;

/**
 * Live reproduction of the "ping probe fails" problem against a real server.
 *
 * Usage: LivePing <global.js> <main.js> <hostname> <srv-port>
 *
 * It replays exactly what Mindustry does:
 *   1. JoinDialog pings the server entry            -> hostname:6567
 *   2. the result is turned into a favourite        -> "resolvedIp:tcpPort"
 *   3. JoinDialog.refreshRemote()/reconnect() pings -> "resolvedIp:tcpPort"
 * Step 3 is the one that used to answer nothing.
 */
public class LivePing{
    static int failures = 0;

    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        String hostname = args[2];

        Core.app = new MockApplication();
        Core.settings = new MockSettings();
        Vars.headless = true;

        Net originalNet = new Net(new ArcNetProvider());
        Vars.net = originalNet;
        originalNet.handleClient(Connect.class, c -> {});
        originalNet.handleServer(mindustry.net.Packets.ConnectPacket.class, (con, p) -> {});

        Context cx = Context.enter();
        cx.setOptimizationLevel(9);
        Scriptable scope = new ImporterTopLevel(cx);
        cx.evaluateString(scope, new String(java.nio.file.Files.readAllBytes(globalJs), StandardCharsets.UTF_8), "global.js", 1);
        ModLoader.runMod(cx, scope, ModLoader.scriptsDirOf(modJs.toString()), "splitport");

        Events.fire(new ClientLoadEvent());
        System.out.println("mod installed: " + (Vars.net != originalNet));

        System.out.println("\n--- step 1: ping the server list entry (domain : 6567) ---");
        Host first = ping(hostname, Vars.port);
        check("domain ping succeeded", first != null);
        if(first == null){
            finish();
            return;
        }
        System.out.println("    Host.address=" + first.address + " Host.port=" + first.port + " ping=" + first.ping + "ms");
        check("Host.port is the SRV TCP port", first.port != Vars.port);

        String favourite = first.address + ":" + first.port;
        System.out.println("\n--- step 2: that is what JoinDialog stores as a favourite: " + favourite + " ---");

        System.out.println("\n--- step 3: refresh / reconnect pings the favourite (ip : tcpPort) ---");
        Host second = ping(first.address, first.port);
        check("ping of the stored \"ip:tcpPort\" entry succeeded", second != null);
        if(second != null){
            System.out.println("    Host.address=" + second.address + " Host.port=" + second.port + " ping=" + second.ping + "ms");
            check("reported Host.port is still the TCP port", second.port == first.port);
        }

        System.out.println("\n--- step 4: control - ping the raw UDP port directly ---");
        Host third = ping(first.address, 23467);
        check("direct UDP-port ping succeeded (server is up)", third != null);

        Context.exit();
        finish();
    }

    static Host ping(String address, int port){
        Host[] result = new Host[1];
        Exception[] error = new Exception[1];
        CountDownLatch latch = new CountDownLatch(1);

        Vars.net.pingHost(address, port, h -> {
            result[0] = h;
            latch.countDown();
        }, e -> {
            error[0] = e;
            latch.countDown();
        });

        try{
            if(!latch.await(20, TimeUnit.SECONDS)){
                System.out.println("    [timeout]");
                return null;
            }
        }catch(InterruptedException e){
            return null;
        }
        if(error[0] != null) System.out.println("    [error] " + error[0]);
        return result[0];
    }

    static void check(String what, boolean ok){
        System.out.println((ok ? "    [PASS] " : "    [FAIL] ") + what);
        if(!ok) failures++;
    }

    static void finish(){
        System.out.println("\n============ " + (failures == 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED") + " ============");
        System.exit(failures == 0 ? 0 : 1);
    }
}
