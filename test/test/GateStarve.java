
import arc.*;
import arc.mock.*;
import arc.struct.*;
import arc.util.*;
import arc.util.serialization.*;
import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.net.*;
import mindustry.net.Packets.Connect;
import rhino.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Does a favourite with a remembered route still ping fast while the whole
 *  community list is being refreshed (gate saturated)? */
public class GateStarve{
    static final TaskQueue queue = new TaskQueue();
    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        var listJson = Paths.get(args[2]);
        String domain = args[3];
        int expectedTcp = Integer.parseInt(args[4]);

        Core.app = new MockApplication(){ @Override public void post(Runnable r){ queue.post(r); } };
        Core.settings = new MockSettings();
        Vars.headless = true;
        Net originalNet = new Net(new ArcNetProvider());
        Vars.net = originalNet;
        originalNet.handleClient(Connect.class, c -> {});
        originalNet.handleServer(mindustry.net.Packets.ConnectPacket.class, (con,p) -> {});

        Context cx = Context.enter();
        cx.setOptimizationLevel(9);
        Scriptable scope = new ImporterTopLevel(cx);
        cx.evaluateString(scope, new String(java.nio.file.Files.readAllBytes(globalJs), StandardCharsets.UTF_8), "global.js", 1);
        ModLoader.runMod(cx, scope, ModLoader.scriptsDirOf(modJs.toString()), "splitport");
        Events.fire(new ClientLoadEvent());
        Thread drain = new Thread(() -> { while(true){ queue.run(); try{Thread.sleep(4);}catch(Exception e){return;} } });
        drain.setDaemon(true); drain.start();

        // Step A: one ping to learn the route (like a first visit)
        long a0 = System.currentTimeMillis();
        long[] firstLat = new long[1];
        CountDownLatch one = new CountDownLatch(1);
        Vars.net.pingHost(domain, Vars.port, h -> { firstLat[0] = System.currentTimeMillis()-a0; one.countDown(); },
                                    e -> { firstLat[0] = System.currentTimeMillis()-a0; one.countDown(); });
        one.await(60, TimeUnit.SECONDS);
        System.out.println("step A first ping (learns route): " + firstLat[0] + "ms");

        // Step B: saturate the SRV gate with the whole community list
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
        CountDownLatch bg = new CountDownLatch(load.size());
        for(String[] t : load) Vars.net.pingHost(t[0], Integer.parseInt(t[1]), h -> bg.countDown(), e -> bg.countDown());

        // Step C: ping the favourite (route already known) while the burst runs
        Thread.sleep(150);
        long c0 = System.currentTimeMillis();
        AtomicLong lat = new AtomicLong(-1);
        AtomicInteger state = new AtomicInteger();
        CountDownLatch tc = new CountDownLatch(1);
        Vars.net.pingHost(domain, Vars.port, (Host h) -> { lat.set(System.currentTimeMillis()-c0); state.set(h.port==expectedTcp?1:2); tc.countDown(); },
                                    (Exception e) -> { lat.set(System.currentTimeMillis()-c0); state.set(3); tc.countDown(); });
        tc.await(60, TimeUnit.SECONDS);
        System.out.println("step C favourite ping during 266-entry burst: " + lat.get() + "ms  state="
            + new String[]{"pending","ok","wrongport","failed"}[state.get()]);
        System.out.println((state.get()==1 && lat.get() < 5000) ? "PASS: known route pings fast under burst" : "FAIL: still slow/wrong");
        System.exit(0);
    }
}
