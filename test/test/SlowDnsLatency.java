
import arc.*;
import arc.mock.*;
import arc.net.dns.*;
import arc.struct.*;
import arc.util.*;

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
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * Measures the worst-case time for the LAST ping in a JoinDialog-sized burst to
 * receive its callback, when the DNS resolver drops SRV queries (timeout).
 *
 * A dropping nameserver means every srvQueryOnce() blocks the full 2000ms socket
 * timeout, and the mod retries 3 times, over 3 nameservers.
 */
public class SlowDnsLatency{
    static final TaskQueue queue = new TaskQueue();

    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        int burst = Integer.parseInt(args[2]);      // how many concurrent pings
        boolean drop = args[3].equals("drop");      // resolver drops SRV queries?

        Core.app = new MockApplication(){ @Override public void post(Runnable r){ queue.post(r); } };
        Core.settings = new MockSettings();
        Vars.headless = true;

        // A nameserver that silently drops everything (black hole) -> 2s timeout each query.
        DatagramSocket blackhole = new DatagramSocket(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
        int bhPort = blackhole.getLocalPort();
        Thread bh = new Thread(() -> {
            byte[] buf = new byte[512];
            while(true){
                try{
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    blackhole.receive(p);
                    if(!drop){ /* echo nothing either way; "answer" mode uses real ns below */ }
                    // in answer mode we don't use the blackhole at all
                }catch(Exception e){ return; }
            }
        });
        bh.setDaemon(true); bh.start();

        if(drop){
            ArcDns.setNameserverProviders(Seq.with(new NameserverProvider(){
                @Override public Seq<InetSocketAddress> getNameservers(){
                    // three black-hole servers -> each query times out 2s, x3 = 6s per attempt
                    return Seq.with(
                        new InetSocketAddress(InetAddress.getLoopbackAddress(), bhPort),
                        new InetSocketAddress(InetAddress.getLoopbackAddress(), bhPort),
                        new InetSocketAddress(InetAddress.getLoopbackAddress(), bhPort));
                }
            }));
        }

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

        // drain the deferred post queue continuously (render loop)
        Thread drain = new Thread(() -> {
            while(true){ queue.run(); try{ Thread.sleep(8); }catch(Exception e){ return; } }
        });
        drain.setDaemon(true); drain.start();

        System.out.println("mode=" + (drop ? "DNS DROPS (timeout)" : "normal") + "  burst=" + burst);
        long start = System.currentTimeMillis();
        AtomicInteger done = new AtomicInteger();
        long[] last = new long[1];
        CountDownLatch all = new CountDownLatch(burst);

        for(int i = 0; i < burst; i++){
            Vars.net.pingHost("mdt-v4-srv.play.jiahai.top", Vars.port, (Host h) -> {
                done.incrementAndGet();
                last[0] = System.currentTimeMillis() - start;
                all.countDown();
            }, (Exception e) -> {
                done.incrementAndGet();
                last[0] = System.currentTimeMillis() - start;
                all.countDown();
            });
        }

        boolean ok = all.await(300, TimeUnit.SECONDS);
        long total = System.currentTimeMillis() - start;
        System.out.println("all callbacks received: " + ok);
        System.out.println("total wall time: " + total + "ms");
        System.out.println("last callback at: " + last[0] + "ms");
        System.out.println("callbacks: " + done.get() + "/" + burst);
        Context.exit();
        System.exit(0);
    }
}
