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
import java.nio.file.*;
import java.util.concurrent.*;

/**
 * Compares what JoinDialog sees for one entry, in the three relevant setups:
 *   vanilla   - no mod, the path a player without SplitPort takes
 *   mod       - SplitPort, no remembered route
 *   modstale  - SplitPort with a remembered route that points at a NAT port
 *               that has since changed (what "restored N remembered routes"
 *               means in a real game after the tunnel was restarted)
 *
 * A ping that calls NEITHER callback is exactly the entry that spins on
 * "refreshing..." forever.
 */
public class CnameCase{
    public static void main(String[] args) throws Exception{
        String globalJs = args[0], modJs = args[1], domain = args[2], mode = args[3];
        String stale = args.length > 4 ? args[4] : null;

        Core.app = new MockApplication();
        Core.settings = new MockSettings();
        Vars.headless = true;
        if(stale != null) Core.settings.put("splitport-routes", stale);

        Net original = new Net(new ArcNetProvider());
        Vars.net = original;
        original.handleClient(Connect.class, c -> {});
        original.handleServer(mindustry.net.Packets.ConnectPacket.class, (con, p) -> {});

        if(!mode.equals("vanilla")){
            Context cx = Context.enter();
            cx.setOptimizationLevel(9);
            Scriptable scope = new ImporterTopLevel(cx);
            cx.evaluateString(scope, read(globalJs), "global.js", 1);
            ModLoader.runMod(cx, scope, ModLoader.scriptsDirOf(modJs), "splitport");
            Events.fire(new ClientLoadEvent());
            System.out.println("mod installed: " + (Vars.net != original)
                + "  Vars.net=" + Vars.net.getClass().getName()
                + "  super=" + Vars.net.getClass().getSuperclass().getName());
        }

        long t0 = System.currentTimeMillis();
        CompletableFuture<String> f = new CompletableFuture<>();
        Vars.net.pingHost(domain, Vars.port,
            (Host h) -> f.complete("VALID   address=" + h.address + " port=" + h.port),
            (Exception e) -> f.complete("INVALID " + e.getClass().getSimpleName() + ": " + e.getMessage()));

        String r;
        try{
            r = f.get(60, TimeUnit.SECONDS);
        }catch(TimeoutException te){
            r = "*** NO CALLBACK AT ALL after 60s -> entry spins on 'refreshing...' forever ***";
        }
        System.out.println("[" + mode + (stale != null ? "+stale-route" : "") + "] " + domain);
        System.out.println("    -> " + r + "   (" + (System.currentTimeMillis() - t0) + "ms)");
        System.exit(0);
    }

    static String read(String p) throws Exception{
        return new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(p)), StandardCharsets.UTF_8);
    }
}
