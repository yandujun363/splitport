
import arc.*;
import arc.mock.*;
import arc.util.TaskQueue;
import mindustry.Vars;
import mindustry.net.ArcNetProvider;
import mindustry.net.Host;
import mindustry.net.Net;
import mindustry.net.Packets.Connect;
import java.util.concurrent.*;

public class VanillaPing{
    static final TaskQueue queue = new TaskQueue();
    public static void main(String[] a) throws Exception{
        Core.app = new MockApplication(){ @Override public void post(Runnable r){ queue.post(r); } };
        Core.settings = new MockSettings();
        Vars.headless = true;
        Net net = new Net(new ArcNetProvider());
        Vars.net = net;
        net.handleClient(Connect.class, c -> {});
        net.handleServer(mindustry.net.Packets.ConnectPacket.class, (c,p) -> {});

        Thread drain = new Thread(() -> { while(true){ queue.run(); try{Thread.sleep(8);}catch(Exception e){return;} } });
        drain.setDaemon(true); drain.start();

        for(String[] t : new String[][]{ {"mdt-v4-srv.play.jiahai.top", "6567"}, {"171.108.71.107","23608"} }){
            CompletableFuture<String> f = new CompletableFuture<>();
            long s = System.currentTimeMillis();
            net.pingHost(t[0], Integer.parseInt(t[1]), (Host h) -> f.complete("OK addr="+h.address+" port="+h.port+" ping="+h.ping),
                e -> f.complete("FAIL " + e));
            try{
                String r = f.get(60, TimeUnit.SECONDS);
                System.out.println("VANILLA ping " + t[0] + ":" + t[1] + " -> " + r + "  (" + (System.currentTimeMillis()-s) + "ms)");
            }catch(Exception e){
                System.out.println("VANILLA ping " + t[0] + ":" + t[1] + " -> NO CALLBACK in 60s  <<< STUCK");
            }
        }
        System.exit(0);
    }
}
