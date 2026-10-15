import arc.*;
import arc.mock.*;
import arc.net.*;
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

import java.io.*;
import java.net.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * Integration harness for the Split Port (SRV) mod.
 *
 * Boots just enough of Mindustry/Arc to run the *real* mod script through
 * Mindustry's own Rhino engine against the *real* Arc networking stack:
 *
 *   [mod client] --TCP--> relay:12565 --TCP--> vanilla server 127.0.0.1:16567
 *   [mod client] --UDP--> relay:12566 --UDP--> vanilla server 127.0.0.1:16567
 *
 * The relay stands in for NAT: the server keeps using one local port for both
 * protocols, while the outside world only sees 12565/TCP and 12566/UDP.
 * A small local DNS server publishes the matching SRV records.
 *
 * Not part of the distributed mod.
 */
public class SplitPortHarness{
    static final int SERVER_TCP = 16567;
    static final int SERVER_UDP = 16567;
    static final int PUB_TCP = 12565;
    static final int PUB_UDP = 12566;
    static final int VANILLA_PORT = 6567;
    static final int TCPONLY_PORT = 15567;
    static final int UDP_ONLY_PORT = 13566;
    static final int DEAD_PORT = 19999;
    static final int DNS_PORT = 15353;
    static final int HOST_PORT = 17567;
    static final String HOSTNAME = "localhost";

    static final InetAddress LOCAL = InetAddress.getLoopbackAddress();

    static int failures = 0;
    static SrvDns dns;
    static Net net;
    static final AtomicBoolean connectEvent = new AtomicBoolean();

    public static void main(String[] args) throws Exception{
        var globalJs = Paths.get(args[0]);
        var modJs = Paths.get(args[1]);
        var metaJs = Paths.get(args[2]);

        // ---- minimal game environment -------------------------------------
        Core.app = new MockApplication();
        Core.settings = new MockSettings();
        Vars.headless = true;

        // ---- DNS with SRV records ----------------------------------------
        dns = new SrvDns(DNS_PORT);
        dns.start();
        ArcDns.setNameserverProviders(Seq.with(new NameserverProvider(){
            @Override
            public Seq<InetSocketAddress> getNameservers(){
                return Seq.with(new InetSocketAddress(LOCAL, DNS_PORT));
            }
        }));

        // ---- infrastructure ----------------------------------------------
        ArcServer split = new ArcServer(SERVER_TCP, SERVER_UDP);
        ArcServer vanilla = new ArcServer(VANILLA_PORT, VANILLA_PORT);
        ArcServer tcpOnly = new ArcServer(TCPONLY_PORT, TCPONLY_PORT);
        TcpRelay tcpRelay = new TcpRelay(PUB_TCP, SERVER_TCP);
        UdpRelay udpRelay = new UdpRelay(PUB_UDP, SERVER_UDP);
        UdpRelay udpOnlyRelay = new UdpRelay(UDP_ONLY_PORT, VANILLA_PORT);

        // ---- original Net, exactly as the game builds it ------------------
        Net originalNet = new Net(new ArcNetProvider());
        Vars.net = originalNet;
        net = originalNet;

        originalNet.handleClient(Connect.class, c -> connectEvent.set(true));
        originalNet.handleClient(mindustry.net.Packets.Disconnect.class, d -> {});
        originalNet.handleServer(mindustry.net.Packets.ConnectPacket.class, (con, p) -> {});
        originalNet.handleServer(mindustry.net.Packets.Disconnect.class, (con, p) -> {});

        int origClientListeners = listenerCount(originalNet, "clientListeners");
        int origServerListeners = listenerCount(originalNet, "serverListeners");
        System.out.println("[harness] packet handlers before install: client=" + origClientListeners
            + " server=" + origServerListeners);

        // ---- run the real mod script in Mindustry's Rhino -----------------
        Context cx = Context.enter();
        cx.setOptimizationLevel(9);
        Scriptable scope = new ImporterTopLevel(cx);

        String global = new String(java.nio.file.Files.readAllBytes(globalJs), StandardCharsets.UTF_8);
        cx.evaluateString(scope, global, "global.js", 1);

        String mod = new String(java.nio.file.Files.readAllBytes(modJs), StandardCharsets.UTF_8);
        cx.evaluateString(scope, "modName = \"split-port-srv\"; scriptName = \"main.js\";", "initscript.js", 1);
        cx.evaluateString(scope, "(function(){'use strict';\n" + mod + "\n})();", "main.js", 1);
        System.out.println("[harness] global.js + mod script evaluated by Rhino");

        // ---- fire ClientLoadEvent -> the mod installs itself --------------
        Events.fire(new ClientLoadEvent());

        System.out.println("\n=== mod metadata ===");
        String metaText = new String(java.nio.file.Files.readAllBytes(metaJs), StandardCharsets.UTF_8);
        arc.util.serialization.Jval meta = arc.util.serialization.Jval.read(metaText);
        check("mod.hjson declares hidden: true (excluded from the multiplayer mod handshake)",
            meta.getBool("hidden", false));
        check("mod.hjson has a displayName and version", meta.getString("displayName", null) != null
            && meta.getString("version", null) != null);

        System.out.println("\n=== install ===");
        check("mod replaced Vars.net", Vars.net != null && Vars.net != originalNet);
        check("every packet handler survived the swap (client "
                + listenerCount(Vars.net, "clientListeners") + "/" + origClientListeners + ")",
            listenerCount(Vars.net, "clientListeners") == origClientListeners);
        check("every packet handler survived the swap (server "
                + listenerCount(Vars.net, "serverListeners") + "/" + origServerListeners + ")",
            listenerCount(Vars.net, "serverListeners") == origServerListeners);

        // =============================================================
        // scenario 1: _tcp + _udp SRV, external TCP and UDP ports differ
        // =============================================================
        System.out.println("\n=== scenario 1: _mindustry._tcp + _mindustry._udp, split ports ===");
        split.start();
        tcpRelay.start();
        udpRelay.start();
        dns.clear();
        dns.put("_mindustry._tcp." + HOSTNAME, 10, 10, PUB_TCP, HOSTNAME);
        dns.put("_mindustry._udp." + HOSTNAME, 10, 10, PUB_UDP, HOSTNAME);

        dns.resetQueries();
        Host host = ping();
        check("ping via SRV succeeded", host != null);
        if(host != null){
            check("Host.port is the externally published TCP port " + PUB_TCP + " (got " + host.port + ")",
                host.port == PUB_TCP);
            check("Host.address is the resolved server ip (got " + host.address + ")",
                "127.0.0.1".equals(host.address));
        }
        check("_mindustry._tcp was queried", dns.queried("_mindustry._tcp." + HOSTNAME));
        check("_mindustry._udp was queried", dns.queried("_mindustry._udp." + HOSTNAME));

        // This is exactly what JoinDialog does: it joins host.address:host.port,
        // i.e. the numeric IP plus the published TCP port - the mod has to
        // remember the matching UDP port from the ping.
        int before = split.connections.get();
        check("client received Connect", connect(host == null ? HOSTNAME : host.address,
            host == null ? PUB_TCP : host.port));
        check("server completed the TCP+UDP registration", split.connections.get() > before && split.udpRegistered.get());
        check("TCP relay was used", tcpRelay.connections.get() > 0);
        check("UDP relay was used", udpRelay.packets.get() > 0);

        // =============================================================
        // scenario 2: no SRV at all -> vanilla single port
        // =============================================================
        System.out.println("\n=== scenario 2: no SRV -> vanilla single-port behaviour ===");
        Vars.net.disconnect();
        connectEvent.set(false);
        vanilla.start();
        dns.clear();

        Host host2 = ping();
        check("direct ping succeeded", host2 != null);
        if(host2 != null){
            check("Host.port stays the vanilla port " + VANILLA_PORT + " (got " + host2.port + ")",
                host2.port == VANILLA_PORT);
        }
        int before2 = vanilla.connections.get();
        check("client received Connect", connect(HOSTNAME, VANILLA_PORT));
        check("vanilla server completed the TCP+UDP registration",
            vanilla.connections.get() > before2 && vanilla.udpRegistered.get());

        // =============================================================
        // scenario 3: only a _udp record -> TCP keeps the default port
        // =============================================================
        System.out.println("\n=== scenario 3: only _mindustry._udp ===");
        Vars.net.disconnect();
        connectEvent.set(false);
        udpOnlyRelay.start();
        dns.clear();
        dns.put("_mindustry._udp." + HOSTNAME, 10, 10, UDP_ONLY_PORT, HOSTNAME);

        int before3 = vanilla.connections.get();
        Host host3 = ping();
        check("ping through the _udp target succeeded", host3 != null);
        if(host3 != null){
            check("unknown _tcp -> TCP falls back to the requested port " + VANILLA_PORT + " (got " + host3.port + ")",
                host3.port == VANILLA_PORT);
        }
        check("client received Connect", connect(HOSTNAME, VANILLA_PORT));
        check("server completed the TCP+UDP registration",
            vanilla.connections.get() > before3 && vanilla.udpRegistered.get());

        // =============================================================
        // scenario 4: only a _tcp record (vanilla SRV style, both ports equal)
        // =============================================================
        System.out.println("\n=== scenario 4: only _mindustry._tcp (vanilla SRV fallback) ===");
        Vars.net.disconnect();
        connectEvent.set(false);
        tcpOnly.start();
        dns.clear();
        dns.put("_mindustry._tcp." + HOSTNAME, 10, 10, TCPONLY_PORT, HOSTNAME);

        Host host4 = ping();
        check("ping through the _tcp target succeeded", host4 != null);
        if(host4 != null){
            check("Host.port is the _tcp record port " + TCPONLY_PORT + " (got " + host4.port + ")",
                host4.port == TCPONLY_PORT);
        }
        int before4 = tcpOnly.connections.get();
        check("client received Connect", connect(HOSTNAME, TCPONLY_PORT));
        check("server completed the TCP+UDP registration",
            tcpOnly.connections.get() > before4 && tcpOnly.udpRegistered.get());

        // =============================================================
        // scenario 5: first _udp record is dead -> next record is used
        // =============================================================
        System.out.println("\n=== scenario 5: dead first _udp record -> second record used ===");
        Vars.net.disconnect();
        connectEvent.set(false);
        dns.clear();
        dns.put("_mindustry._tcp." + HOSTNAME, 10, 10, PUB_TCP, HOSTNAME);
        dns.put("_mindustry._udp." + HOSTNAME, 10, 10, DEAD_PORT, HOSTNAME);
        dns.put("_mindustry._udp." + HOSTNAME, 20, 10, PUB_UDP, HOSTNAME);

        int before5 = split.connections.get();
        Host host5 = ping();
        check("ping succeeded despite the dead first record", host5 != null);
        if(host5 != null){
            check("Host.port is still the TCP port " + PUB_TCP + " (got " + host5.port + ")",
                host5.port == PUB_TCP);
        }
        check("client received Connect", connect(host5 == null ? HOSTNAME : host5.address,
            host5 == null ? PUB_TCP : host5.port));
        check("server completed the TCP+UDP registration", split.connections.get() > before5);

        // =============================================================
        // scenario 6: re-ping the way JoinDialog stores a favourite
        //            ("<resolved ip>:<tcp port>") and the way reconnect() does
        // =============================================================
        System.out.println("\n=== scenario 6: ping a favourite stored as ip:tcpPort ===");
        dns.clear();
        dns.put("_mindustry._tcp." + HOSTNAME, 10, 10, PUB_TCP, HOSTNAME);
        dns.put("_mindustry._udp." + HOSTNAME, 10, 10, PUB_UDP, HOSTNAME);

        Host fresh = ping();
        check("domain ping succeeded", fresh != null && "127.0.0.1".equals(fresh.address) && fresh.port == PUB_TCP);

        System.out.println("  [harness] JoinDialog would now store \"" + (fresh == null ? "?" : fresh.address + ":" + fresh.port) + "\"");
        Host again = ping("127.0.0.1", fresh == null ? PUB_TCP : fresh.port);
        check("re-ping of the stored ip:tcpPort entry succeeded", again != null);
        if(again != null){
            check("reported Host.port is still the TCP port " + PUB_TCP + " (got " + again.port + ")",
                again.port == PUB_TCP);
        }

        // =============================================================
        // scenario 7: the same, but after a "restart": a brand new script
        //            scope with an empty in-memory route table, so the route
        //            can only come from the settings written by scenario 6
        // =============================================================
        System.out.println("\n=== scenario 7: ip:tcpPort ping after a restart (route restored from settings) ===");
        String persisted = Core.settings.getString("splitport-routes", "");
        System.out.println("  [harness] persisted routes: " + persisted);
        check("learned split-port route was written to settings", persisted.contains("127.0.0.1|" + PUB_TCP + "|"));

        // a fresh Net + a fresh script scope, as if the game had just started
        Vars.net = new Net(new ArcNetProvider());
        Net afterRestart = Vars.net;
        afterRestart.handleClient(Connect.class, c -> connectEvent.set(true));
        afterRestart.handleServer(mindustry.net.Packets.ConnectPacket.class, (con, p) -> {});

        Context.exit();
        Context cx2 = Context.enter();
        cx2.setOptimizationLevel(9);
        Scriptable scope2 = new ImporterTopLevel(cx2);
        cx2.evaluateString(scope2, global, "global.js", 1);
        cx2.evaluateString(scope2, "modName = \"split-port-srv\"; scriptName = \"main.js\";", "initscript.js", 1);
        cx2.evaluateString(scope2, "(function(){'use strict';\n" + mod + "\n})();", "main.js", 1);

        // DNS deliberately answers nothing now: only the restored route can work
        dns.clear();
        Events.fire(new ClientLoadEvent());
        check("mod installed on the fresh Net", Vars.net != afterRestart);

        Host restored = ping("127.0.0.1", PUB_TCP);
        check("ip:tcpPort ping works with no DNS and no prior ping in this session", restored != null);
        if(restored != null){
            check("restored Host.port is the TCP port " + PUB_TCP + " (got " + restored.port + ")",
                restored.port == PUB_TCP);
        }

        // =============================================================
        // scenario 8: hosting a game still binds both protocols
        // =============================================================
        System.out.println("\n=== scenario 8: hosting still works ===");
        Vars.net.disconnect();
        boolean hosted = true;
        try{
            Vars.net.host(HOST_PORT);
        }catch(Throwable t){
            hosted = false;
            System.out.println("  [harness] host() threw: " + t);
        }
        check("hosting a server succeeds", hosted);
        check("hosted TCP port is bound", !canBindTcp(HOST_PORT));
        check("hosted UDP port is bound", !canBindUdp(HOST_PORT));
        try{
            Vars.net.closeServer();
        }catch(Throwable t){
            System.out.println("  [harness] closeServer(): " + t);
        }

        // ---- teardown -----------------------------------------------------
        tcpRelay.close();
        udpRelay.close();
        udpOnlyRelay.close();
        dns.close();
        split.close();
        vanilla.close();
        tcpOnly.close();

        System.out.println("\n================ RESULT ================");
        System.out.println(failures == 0 ? "ALL CHECKS PASSED" : (failures + " CHECK(S) FAILED"));
        System.exit(failures == 0 ? 0 : 1);
    }

    // ------------------------------------------------------------------
    // scenario helpers
    // ------------------------------------------------------------------

    static Host ping(){
        return ping(HOSTNAME, Vars.port);
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
                System.out.println("  [harness] ping of " + address + ":" + port + " timed out");
                return null;
            }
        }catch(InterruptedException e){
            return null;
        }
        if(error[0] != null) System.out.println("  [harness] ping error: " + error[0]);
        return result[0];
    }

    static boolean connect(String address, int port){
        Vars.net.connect(address, port, () -> {});
        return waitFor(() -> connectEvent.get(), 15000);
    }

    static void check(String what, boolean ok){
        System.out.println((ok ? "  [PASS] " : "  [FAIL] ") + what);
        if(!ok) failures++;
    }

    static boolean waitFor(java.util.function.BooleanSupplier condition, long millis){
        long end = System.currentTimeMillis() + millis;
        while(System.currentTimeMillis() < end){
            if(condition.getAsBoolean()) return true;
            try{
                Thread.sleep(25);
            }catch(InterruptedException ignored){
            }
        }
        return condition.getAsBoolean();
    }

    static boolean canBindTcp(int port){
        try(ServerSocket s = new ServerSocket(port, 1, LOCAL)){
            return true;
        }catch(IOException e){
            return false;
        }
    }

    static boolean canBindUdp(int port){
        try(DatagramSocket s = new DatagramSocket(new InetSocketAddress(LOCAL, port))){
            return true;
        }catch(IOException e){
            return false;
        }
    }

    static int listenerCount(Net target, String field){
        return map(target, field).size;
    }

    static arc.struct.ObjectMap<?, ?> map(Net target, String field){
        try{
            java.lang.reflect.Field f = Net.class.getDeclaredField(field);
            f.setAccessible(true);
            return (arc.struct.ObjectMap<?, ?>)f.get(target);
        }catch(Exception e){
            throw new RuntimeException(e);
        }
    }

    // ------------------------------------------------------------------
    // a "vanilla" Mindustry server built straight on Arc
    // ------------------------------------------------------------------

    static class ArcServer implements Closeable{
        final Server server;
        final int tcpPort, udpPort;
        final AtomicInteger connections = new AtomicInteger();
        final AtomicBoolean udpRegistered = new AtomicBoolean();

        ArcServer(int tcpPort, int udpPort){
            this.tcpPort = tcpPort;
            this.udpPort = udpPort;
            // same buffer sizes as mindustry.net.ArcNetProvider
            this.server = new Server(ArcNetProvider.clientReadBufferSize + 16_000, 16384,
                new ArcNetProvider.PacketSerializer());

            server.setDiscoveryHandler((address, handler) -> handler.respond(serverInfo()));

            server.addListener(new NetListener(){
                @Override
                public void connected(Connection connection){
                    connections.incrementAndGet();
                    if(connection.getRemoteAddressUDP() != null) udpRegistered.set(true);
                    System.out.println("  [server:" + tcpPort + "] connected tcp=" + connection.getRemoteAddressTCP()
                        + " udp=" + connection.getRemoteAddressUDP());
                }
            });
        }

        /** Mirrors NetworkIO.writeServerData. The advertised port is the
         *  server's *local* port, so a passing test proves the mod replaced it
         *  with the externally published TCP port. */
        static ByteBuffer serverInfo(){
            ByteBuffer b = ByteBuffer.allocate(512);
            putString(b, "Harness Server");
            putString(b, "Harness Map");
            b.putInt(1);        // players
            b.putInt(3);        // wave
            b.putInt(146);      // version
            putString(b, "official");
            b.put((byte)0);     // gamemode
            b.putInt(10);       // player limit
            putString(b, "integration test");
            putString(b, "");   // mode name
            b.putShort((short)VANILLA_PORT);
            b.flip();
            return b;
        }

        static void putString(ByteBuffer b, String s){
            byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
            b.put((byte)bytes.length);
            b.put(bytes);
        }

        void start(){
            try{
                server.bind(tcpPort, udpPort);
            }catch(IOException e){
                throw new RuntimeException(e);
            }
            Thread thread = new Thread(() -> {
                try{
                    server.run();
                }catch(Throwable ignored){
                }
            }, "harness-server-" + tcpPort);
            thread.setDaemon(true);
            thread.start();
        }

        @Override
        public void close(){
            try{
                server.stop();
            }catch(Throwable ignored){
            }
        }
    }

    // ------------------------------------------------------------------
    // NAT stand-ins
    // ------------------------------------------------------------------

    static class TcpRelay implements Closeable{
        final ServerSocket listener;
        final int targetPort;
        final AtomicInteger connections = new AtomicInteger();
        volatile boolean closed;

        TcpRelay(int listenPort, int targetPort) throws IOException{
            this.targetPort = targetPort;
            this.listener = new ServerSocket(listenPort, 50, LOCAL);
        }

        void start(){
            Thread t = new Thread(() -> {
                while(!closed){
                    try{
                        Socket client = listener.accept();
                        Socket server = new Socket(LOCAL, targetPort);
                        connections.incrementAndGet();
                        pump(client, server);
                        pump(server, client);
                    }catch(Exception e){
                        if(!closed) System.out.println("  [tcprelay] " + e);
                    }
                }
            }, "tcp-relay");
            t.setDaemon(true);
            t.start();
        }

        static void pump(Socket from, Socket to){
            Thread t = new Thread(() -> {
                try{
                    InputStream in = from.getInputStream();
                    OutputStream out = to.getOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while((n = in.read(buf)) > 0){
                        out.write(buf, 0, n);
                        out.flush();
                    }
                }catch(Exception ignored){
                }finally{
                    try{
                        to.close();
                    }catch(Exception ignored){
                    }
                }
            });
            t.setDaemon(true);
            t.start();
        }

        @Override
        public void close(){
            closed = true;
            try{
                listener.close();
            }catch(IOException ignored){
            }
        }
    }

    static class UdpRelay implements Closeable{
        final DatagramSocket clientSide;
        final DatagramSocket serverSide;
        final int targetPort;
        final AtomicInteger packets = new AtomicInteger();
        volatile InetSocketAddress lastClient;
        volatile boolean started;
        volatile boolean closed;

        UdpRelay(int listenPort, int targetPort) throws IOException{
            this.targetPort = targetPort;
            this.clientSide = new DatagramSocket(new InetSocketAddress(LOCAL, listenPort));
            this.serverSide = new DatagramSocket(new InetSocketAddress(LOCAL, 0));
        }

        void start(){
            if(started) return;
            started = true;

            Thread a = new Thread(() -> {
                byte[] buf = new byte[2048];
                while(!closed){
                    try{
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        clientSide.receive(p);
                        packets.incrementAndGet();
                        lastClient = new InetSocketAddress(p.getAddress(), p.getPort());
                        serverSide.send(new DatagramPacket(p.getData(), p.getLength(), LOCAL, targetPort));
                    }catch(Exception e){
                        if(!closed) System.out.println("  [udprelay-a] " + e);
                    }
                }
            }, "udp-relay-a-" + targetPort);
            a.setDaemon(true);
            a.start();

            Thread b = new Thread(() -> {
                byte[] buf = new byte[4096];
                while(!closed){
                    try{
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        serverSide.receive(p);
                        InetSocketAddress dest = lastClient;
                        if(dest != null){
                            clientSide.send(new DatagramPacket(p.getData(), p.getLength(), dest));
                        }
                    }catch(Exception e){
                        if(!closed) System.out.println("  [udprelay-b] " + e);
                    }
                }
            }, "udp-relay-b-" + targetPort);
            b.setDaemon(true);
            b.start();
        }

        @Override
        public void close(){
            closed = true;
            clientSide.close();
            serverSide.close();
        }
    }

    // ------------------------------------------------------------------
    // tiny authoritative DNS server answering SRV queries only
    // ------------------------------------------------------------------

    static class SrvDns implements Closeable{
        final DatagramSocket socket;
        final Map<String, List<String[]>> records = new ConcurrentHashMap<>();
        final Set<String> queries = ConcurrentHashMap.newKeySet();
        volatile boolean closed;

        SrvDns(int port) throws IOException{
            socket = new DatagramSocket(new InetSocketAddress(LOCAL, port));
        }

        void put(String name, int priority, int weight, int port, String target){
            records.computeIfAbsent(name.toLowerCase(Locale.ROOT), k -> new CopyOnWriteArrayList<>())
                .add(new String[]{"" + priority, "" + weight, "" + port, target});
        }

        void clear(){
            records.clear();
        }

        void resetQueries(){
            queries.clear();
        }

        boolean queried(String name){
            return queries.contains(name.toLowerCase(Locale.ROOT));
        }

        void start(){
            Thread t = new Thread(() -> {
                byte[] buf = new byte[1024];
                while(!closed){
                    try{
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        socket.receive(p);
                        byte[] reply = handle(Arrays.copyOf(p.getData(), p.getLength()));
                        socket.send(new DatagramPacket(reply, reply.length, p.getAddress(), p.getPort()));
                    }catch(Exception e){
                        if(!closed) System.out.println("  [dns] " + e);
                    }
                }
            }, "dns");
            t.setDaemon(true);
            t.start();
        }

        byte[] handle(byte[] query){
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            int id = ((query[0] & 0xff) << 8) | (query[1] & 0xff);

            StringBuilder name = new StringBuilder();
            int i = 12;
            while(i < query.length && query[i] != 0){
                int len = query[i++] & 0xff;
                if(i + len > query.length) break;
                if(name.length() > 0) name.append('.');
                name.append(new String(query, i, len, StandardCharsets.US_ASCII));
                i += len;
            }
            i++;
            int qEnd = i + 4;

            String qname = name.toString().toLowerCase(Locale.ROOT);
            queries.add(qname);
            List<String[]> answers = records.get(qname);
            int ancount = answers == null ? 0 : answers.size();

            writeShort(out, id);
            writeShort(out, 0x8180);   // response, recursion available
            writeShort(out, 1);        // qdcount
            writeShort(out, ancount);
            writeShort(out, 0);
            writeShort(out, 0);

            out.write(query, 12, qEnd - 12);

            if(answers != null){
                for(String[] a : answers){
                    writeShort(out, 0xC00C);       // pointer to the question name
                    writeShort(out, 33);           // SRV
                    writeShort(out, 1);            // IN
                    writeInt(out, 300);
                    ByteArrayOutputStream rdata = new ByteArrayOutputStream();
                    writeShort(rdata, Integer.parseInt(a[0]));
                    writeShort(rdata, Integer.parseInt(a[1]));
                    writeShort(rdata, Integer.parseInt(a[2]));
                    // deliberately uncompressed: ArcDns cannot follow pointers in RDATA
                    for(String label : a[3].split("\\.")){
                        rdata.write(label.length());
                        rdata.write(label.getBytes(StandardCharsets.US_ASCII), 0, label.length());
                    }
                    rdata.write(0);
                    writeShort(out, rdata.size());
                    out.write(rdata.toByteArray(), 0, rdata.size());
                }
            }

            return out.toByteArray();
        }

        static void writeShort(ByteArrayOutputStream o, int v){
            o.write((v >> 8) & 0xff);
            o.write(v & 0xff);
        }

        static void writeInt(ByteArrayOutputStream o, int v){
            o.write((v >> 24) & 0xff);
            o.write((v >> 16) & 0xff);
            o.write((v >> 8) & 0xff);
            o.write(v & 0xff);
        }

        @Override
        public void close(){
            closed = true;
            socket.close();
        }
    }
}
