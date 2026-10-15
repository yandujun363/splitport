
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

/** Full-burst stress with REAL deferred post semantics. */
public class BurstRealPost{
    static final TaskQueue queue = new TaskQueue();

    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        var listJson = Paths.get(args[2]);
        String domain = args[3];
        int expectedTcp = Integer.parseInt(args[4]);
        int rounds = Integer.parseInt(args[5]);
        int repeats = Integer.parseInt(args[6]);

        Core.app = new MockApplication(){
            @Override public void post(Runnable r){ queue.post(r); }
        };
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
        cx.evaluateString(scope, "modName = \"split-port-srv\"; scriptName = \"main.js\";", "initscript.js", 1);
        cx.evaluateString(scope, "(function(){'use strict';\n"
            + new String(java.nio.file.Files.readAllBytes(modJs), StandardCharsets.UTF_8) + "\n})();", "main.js", 1);

        Events.fire(new ClientLoadEvent());

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
        System.out.println("background entries: " + load.size() + "  rounds=" + rounds + "  repeats=" + repeats);

        AtomicInteger right = new AtomicInteger(), wrong = new AtomicInteger(), failed = new AtomicInteger();
        List<String> examples = Collections.synchronizedList(new ArrayList<>());

        for(int round = 0; round < rounds; round++){
            CountDownLatch burst = new CountDownLatch(load.size() + repeats);
            System.out.println("\n--- round " + round + " ---");
            for(String[] t : load){
                Vars.net.pingHost(t[0], Integer.parseInt(t[1]), h -> burst.countDown(), e -> burst.countDown());
            }
            for(int k = 0; k < repeats; k++){
                Vars.net.pingHost(domain, Vars.port, (Host h) -> {
                    if(h.port == expectedTcp) right.incrementAndGet(); else { wrong.incrementAndGet(); examples.add("wrong port " + h.port); }
                    burst.countDown();
                }, (Exception e) -> {
                    failed.incrementAndGet();
                    if(examples.size() < 10) examples.add("" + e);
                    burst.countDown();
                });
            }
            // drain the deferred post queue like the render loop does
            long t0 = System.currentTimeMillis();
            while(burst.getCount() > 0 && System.currentTimeMillis() - t0 < 120000){
                queue.run();
                Thread.sleep(8);
            }
            queue.run();
            System.out.println("  round " + round + " done, queue.size=" + queue.size());
        }

        System.out.println("\n=== RESULT ===");
        System.out.println("correct=" + right.get() + "  wrong=" + wrong.get() + "  failed=" + failed.get());
        for(String e : examples) System.out.println("   e.g. " + e);
        Context.exit();
        System.exit((failed.get()==0 && wrong.get()==0) ? 0 : 1);
    }
}
