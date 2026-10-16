
import arc.*;
import arc.mock.*;
import arc.net.dns.*;
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

import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * Full community-list burst with a flaky resolver (drops a fraction of SRV queries).
 * Measures the callback latency of the split-port target.
 */
public class FlakyBurst{
    static final TaskQueue queue = new TaskQueue();
    static final AtomicInteger dropped = new AtomicInteger(), answered = new AtomicInteger();

    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        var listJson = Paths.get(args[2]);
        String domain = args[3];
        int expectedTcp = Integer.parseInt(args[4]);
        final double dropRate = Double.parseDouble(args[5]);   // e.g. 0.8

        Core.app = new MockApplication(){ @Override public void post(Runnable r){ queue.post(r); } };
        Core.settings = new MockSettings();
        Vars.headless = true;

        // --- flaky DNS: a UDP proxy in front of the system's real nameserver 10.0.0.8 ---
        final InetAddress realNs = InetAddress.getByName("10.0.0.8");
        DatagramSocket front = new DatagramSocket(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
        final int frontPort = front.getLocalPort();
        final Random rnd = new Random(12345);

        Thread proxy = new Thread(() -> {
            byte[] buf = new byte[512];
            while(true){
                try{
                    DatagramPacket q = new DatagramPacket(buf, buf.length);
                    front.receive(q);
                    if(rnd.nextDouble() < dropRate){ dropped.incrementAndGet(); continue; }
                    answered.incrementAndGet();
                    // forward to the real resolver and reply back to the querier
                    try(DatagramSocket up = new DatagramSocket()){
                        up.setSoTimeout(2000);
                        up.send(new DatagramPacket(q.getData(), q.getLength(), realNs, 53));
                        byte[] rb = new byte[512];
                        DatagramPacket r = new DatagramPacket(rb, rb.length);
                        up.receive(r);
                        front.send(new DatagramPacket(r.getData(), r.getLength(), q.getSocketAddress()));
                    }
                }catch(Exception e){ /* drop on any error */ }
            }
        });
        proxy.setDaemon(true); proxy.start();

        ArcDns.setNameserverProviders(Seq.with(new NameserverProvider(){
            @Override public Seq<InetSocketAddress> getNameservers(){
                return Seq.with(new InetSocketAddress(InetAddress.getLoopbackAddress(), frontPort));
            }
        }));

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

        Thread drain = new Thread(() -> { while(true){ queue.run(); try{Thread.sleep(8);}catch(Exception e){return;} } });
        drain.setDaemon(true); drain.start();

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

        System.out.println("dropRate=" + dropRate + "  background=" + load.size());
        long t0 = System.currentTimeMillis();
        AtomicLong targetLatency = new AtomicLong(-1);
        AtomicInteger targetState = new AtomicInteger(0); // 0=pending 1=ok 2=wrong 3=fail
        CountDownLatch bg = new CountDownLatch(load.size());
        for(String[] t : load){
            Vars.net.pingHost(t[0], Integer.parseInt(t[1]), h -> bg.countDown(), e -> bg.countDown());
        }
        Vars.net.pingHost(domain, Vars.port, (Host h) -> {
            targetLatency.compareAndSet(-1, System.currentTimeMillis() - t0);
            targetState.set(h.port == expectedTcp ? 1 : 2);
        }, (Exception e) -> {
            targetLatency.compareAndSet(-1, System.currentTimeMillis() - t0);
            targetState.set(3);
        });

        // wait for either the target or a generous timeout
        long deadline = System.currentTimeMillis() + 240000;
        while(targetState.get() == 0 && System.currentTimeMillis() < deadline){
            queue.run();
            Thread.sleep(20);
        }
        System.out.println("target latency: " + (targetLatency.get() < 0 ? ">240s (STUCK)" : targetLatency.get() + "ms")
            + "  state=" + new String[]{"pending","ok","wrongport","failed"}[targetState.get()]);
        System.out.println("dns queries dropped=" + dropped.get() + " answered=" + answered.get());
        Context.exit();
        System.exit(0);
    }
}
