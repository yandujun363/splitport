
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
import java.util.concurrent.atomic.*;

/** Repeat pings of the SRV domain and record latency/outcome distribution. */
public class RepeatPing{
    static final TaskQueue queue = new TaskQueue();
    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        String domain = args[2];
        int trials = Integer.parseInt(args[3]);

        Core.app = new MockApplication(){ @Override public void post(Runnable r){ queue.post(r); } };
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

        Thread drain = new Thread(() -> { while(true){ queue.run(); try{Thread.sleep(4);}catch(Exception e){return;} } });
        drain.setDaemon(true); drain.start();

        int ok=0, bad=0;
        for(int i=0;i<trials;i++){
            CompletableFuture<Host> f = new CompletableFuture<>();
            CompletableFuture<Exception> fe = new CompletableFuture<>();
            long s = System.currentTimeMillis();
            Vars.net.pingHost(domain, Vars.port, h -> f.complete(h), e -> fe.complete(e));
            long deadline = System.currentTimeMillis()+30000;
            while(!f.isDone() && !fe.isDone() && System.currentTimeMillis()<deadline){ queue.run(); Thread.sleep(2); }
            long dt = System.currentTimeMillis()-s;
            if(f.isDone()){ Host h=f.getNow(null); System.out.println("trial "+i+": OK port="+h.port+"  "+dt+"ms"); if(h.port==23608) ok++; else bad++; }
            else if(fe.isDone()){ System.out.println("trial "+i+": FAIL "+fe.getNow(null)+"  "+dt+"ms"); bad++; }
            else { System.out.println("trial "+i+": STUCK >30s"); bad++; }
            Thread.sleep(200);
        }
        System.out.println("\nsummary: ok="+ok+" bad="+bad+" of "+trials);
        Context.exit();
        System.exit(0);
    }
}
