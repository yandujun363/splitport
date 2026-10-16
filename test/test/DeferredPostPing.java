
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

/** MockApplication whose post() defers to a queue, like the real game. */
public class DeferredPostPing{
    static final TaskQueue queue = new TaskQueue();

    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        String hostname = args[2];

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
        ModLoader.runMod(cx, scope, ModLoader.scriptsDirOf(modJs.toString()), "splitport");

        Events.fire(new ClientLoadEvent());
        System.out.println("mod installed: " + (Vars.net != originalNet));

        System.out.println("\n--- ping " + hostname + ":" + Vars.port + " with DEFERRED post (real game semantics) ---");
        final CountDownLatch done = new CountDownLatch(1);
        final Host[] got = new Host[1];
        final Exception[] err = new Exception[1];
        final long start = System.currentTimeMillis();

        Vars.net.pingHost(hostname, Vars.port, h -> { got[0] = h; done.countDown(); }, e -> { err[0] = e; done.countDown(); });

        // Simulate the render loop: drain the post queue every ~16ms
        Thread main = new Thread(() -> {
            while(done.getCount() > 0 && System.currentTimeMillis() - start < 30000){
                queue.run();
                try{ Thread.sleep(16); }catch(InterruptedException ignored){}
            }
            queue.run();
        });
        main.setDaemon(true);
        main.start();

        boolean ok = done.await(35, TimeUnit.SECONDS);
        System.out.println("callback fired within 35s: " + ok);
        if(!ok){
            System.out.println("  >>> STILL PENDING: this is the 'PING stays loading' symptom <<<");
            System.out.println("  pending posted runnables: " + queue.size());
        }else{
            System.out.println("  Host=" + (got[0] != null ? got[0].address + ":" + got[0].port + " ping=" + got[0].ping + "ms" : "null")
                + "  error=" + err[0]);
        }
        Context.exit();
        System.exit(ok ? 0 : 1);
    }
}
