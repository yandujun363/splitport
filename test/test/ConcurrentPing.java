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
 * Reproduces what JoinDialog does on refresh: ping every entry of the
 * community server list (plus the test server in several forms) at the same
 * time and verify that EVERY ping reports back exactly once.
 *
 * Usage: ConcurrentPing <global.js> <main.js> <servers.json> <extraDomain>
 */
public class ConcurrentPing{
    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        var listJson = Paths.get(args[2]);
        String extra = args.length > 3 ? args[3] : null;

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
        cx.evaluateString(scope, "modName = \"split-port-srv\"; scriptName = \"main.js\";", "initscript.js", 1);
        cx.evaluateString(scope, "(function(){'use strict';\n"
            + new String(java.nio.file.Files.readAllBytes(modJs), StandardCharsets.UTF_8) + "\n})();", "main.js", 1);

        boolean vanilla = args.length > 4 && args[4].equals("vanilla");
        if(!vanilla) Events.fire(new ClientLoadEvent());
        System.out.println("mod installed: " + (Vars.net != originalNet) + (vanilla ? "   (VANILLA BASELINE)" : ""));

        // collect every address from the community list, exactly like JoinDialog
        List<String[]> targets = new ArrayList<>();
        Jval root = Jval.read(new String(java.nio.file.Files.readAllBytes(listJson), StandardCharsets.UTF_8));
        for(Jval entry : root.asArray()){
            Jval addrs = entry.get("address");
            if(addrs == null) continue;
            for(Jval addr : addrs.asArray()){
                String s = addr.asString();
                int idx = s.lastIndexOf(':');
                if(idx <= 0) targets.add(new String[]{s, "" + Vars.port});
                else targets.add(new String[]{s.substring(0, idx), s.substring(idx + 1)});
            }
        }
        System.out.println("community entries: " + targets.size());

        // the test server, in every form the game may ask about it
        if(extra != null){
            targets.add(new String[]{extra, "" + Vars.port});
            targets.add(new String[]{extra, "6567"});
            targets.add(new String[]{"mdt-v4-srv.play.jiahai.top", "" + Vars.port});
            targets.add(new String[]{"mdt-v4-srv.play.jiahai.top", "23608"});
            targets.add(new String[]{"171.108.71.107", "23608"});
        }

        CountDownLatch done = new CountDownLatch(targets.size());
        AtomicInteger valid = new AtomicInteger();
        AtomicInteger invalid = new AtomicInteger();
        Set<String> pending = ConcurrentHashMap.newKeySet();
        Map<String, String> errors = new ConcurrentHashMap<>();

        for(String[] t : targets){
            String key = t[0] + ":" + t[1];
            pending.add(key);
            Vars.net.pingHost(t[0], Integer.parseInt(t[1]), (Host h) -> {
                valid.incrementAndGet();
                pending.remove(key);
                done.countDown();
            }, (Exception e) -> {
                invalid.incrementAndGet();
                errors.put(key, String.valueOf(e));
                pending.remove(key);
                done.countDown();
            });
        }

        long start = System.currentTimeMillis();
        boolean finished = done.await(180, TimeUnit.SECONDS);
        long elapsed = System.currentTimeMillis() - start;

        System.out.println("\n--- concurrent ping result ---");
        System.out.println("fired      : " + targets.size());
        System.out.println("answered   : " + (targets.size() - pending.size())
            + "  (ok=" + valid.get() + ", failed=" + invalid.get() + ")");
        System.out.println("elapsed    : " + elapsed + "ms   allReported=" + finished);
        System.out.println("NO ANSWER  : " + pending.size());
        for(String key : pending){
            System.out.println("    " + key);
        }

        if(extra != null){
            System.out.println("\n--- test server forms ---");
            for(String[] t : targets){
                String key = t[0] + ":" + t[1];
                if(t[0].contains("jiahai") || t[0].startsWith("171.108.71.107")){
                    System.out.println("    " + key + " -> " + (pending.contains(key) ? "NO ANSWER" : errors.getOrDefault(key, "ok")));
                }
            }
        }

        Context.exit();
        System.out.println("\n" + (pending.isEmpty() ? "ALL PINGS REPORTED BACK" : pending.size() + " PING(S) NEVER REPORTED BACK"));
        System.exit(pending.isEmpty() ? 0 : 1);
    }
}
