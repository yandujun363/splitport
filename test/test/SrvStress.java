import arc.*;
import arc.mock.*;
import arc.struct.*;
import arc.util.*;
import arc.util.serialization.*;

import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.net.ArcNetProvider;
import mindustry.net.Host;
import mindustry.net.Net;
import mindustry.net.Packets.Connect;

import rhino.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * Regression test for the "ping probe fails" bug.
 *
 * JoinDialog refreshes the community list by pinging every entry at once, so it
 * fires ~270 concurrent pings; the domain entries each trigger SRV lookups. The
 * local resolver drops UDP DNS answers when it is flooded and ArcDns turns a
 * dropped lookup into an empty result, so the mod used to fall back to the
 * vanilla single-port ping - which fails for a domain that only exists through
 * SRV.
 *
 * This test reproduces that exact burst and checks that a pure-SRV server is
 * always resolved with the right TCP/UDP port pair.
 *
 * Usage: SrvStress <global.js> <main.js> <servers.json> <domain> <expectedTcpPort> <repeats>
 */
public class SrvStress{
    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        var listJson = Paths.get(args[2]);
        String domain = args[3];
        int expectedTcp = Integer.parseInt(args[4]);
        int repeats = Integer.parseInt(args[5]);

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

        // background load: every community entry, exactly like JoinDialog
        List<String[]> load = new ArrayList<>();
        Jval root = Jval.read(new String(java.nio.file.Files.readAllBytes(listJson), StandardCharsets.UTF_8));
        for(Jval entry : root.asArray()){
            Jval addrs = entry.get("address");
            if(addrs == null) continue;
            for(Jval addr : addrs.asArray()){
                String s = addr.asString();
                int idx = s.lastIndexOf(':');
                load.add(idx <= 0 ? new String[]{s, "" + Vars.port} : new String[]{s.substring(0, idx), s.substring(idx + 1)});
            }
        }
        System.out.println("background pings: " + load.size() + "   target repeats: " + repeats + "  (" + domain + ")");

        int rounds = Integer.parseInt(args[6]);

        AtomicInteger right = new AtomicInteger(), wrongPort = new AtomicInteger(), invalid = new AtomicInteger();
        List<String> wrongExamples = Collections.synchronizedList(new ArrayList<>());

        // Each round is one server-list refresh: every community entry is pinged
        // at once (like JoinDialog.refreshRemote) together with ONE ping of the
        // target server, which is how many times the game really asks for it.
        for(int round = 0; round < rounds; round++){
            final int roundNo = round;
            CountDownLatch burst = new CountDownLatch(load.size() + repeats);
            AtomicInteger roundRight = new AtomicInteger(), roundWrong = new AtomicInteger(), roundBad = new AtomicInteger();

            for(String[] t : load){
                Vars.net.pingHost(t[0], Integer.parseInt(t[1]), h -> burst.countDown(), e -> burst.countDown());
            }
            // several entries of the same server, like a favourite + the
            // community list + the "recent" group all refreshing together
            for(int k = 0; k < repeats; k++){
                Vars.net.pingHost(domain, Vars.port, (Host h) -> {
                    if(h.port == expectedTcp) roundRight.incrementAndGet();
                    else roundWrong.incrementAndGet();
                    burst.countDown();
                }, (Exception e) -> {
                    roundBad.incrementAndGet();
                    if(wrongExamples.size() < 6) wrongExamples.add("round " + roundNo + ": " + e);
                    burst.countDown();
                });
            }

            burst.await(240, TimeUnit.SECONDS);

            right.addAndGet(roundRight.get());
            wrongPort.addAndGet(roundWrong.get());
            invalid.addAndGet(roundBad.get());
            System.out.println("  round " + roundNo + ": correct=" + roundRight.get()
                + " wrong=" + roundWrong.get() + " failed=" + roundBad.get());
        }

        System.out.println("\n--- target results (" + rounds + " refreshes of " + domain + ":6567) ---");
        System.out.println("  correct TCP port " + expectedTcp + " : " + right.get());
        System.out.println("  wrong TCP port           : " + wrongPort.get());
        System.out.println("  ping failed (no answer)  : " + invalid.get());
        for(String ex : wrongExamples) System.out.println("    e.g. " + ex);

        boolean ok = right.get() == rounds * repeats && wrongPort.get() == 0 && invalid.get() == 0;
        System.out.println("\n" + (ok ? "PASS: every refresh resolved the split ports" : "FAIL: some refreshes did not resolve the split ports"));
        Context.exit();
        System.exit(ok ? 0 : 1);
    }
}
