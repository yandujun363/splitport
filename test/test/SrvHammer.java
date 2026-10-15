import arc.net.dns.*;
import arc.struct.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class SrvHammer{
    public static void main(String[] a) throws Exception{
        String tcp = "_mindustry._tcp.mdt-v4-srv.play.jiahai.top";
        String udp = "_mindustry._udp.mdt-v4-srv.play.jiahai.top";
        int n = Integer.parseInt(a.length > 0 ? a[0] : "150");

        for(String name : new String[]{tcp, udp}){
            ExecutorService pool = Executors.newFixedThreadPool(n);
            CountDownLatch start = new CountDownLatch(1);
            AtomicInteger empty = new AtomicInteger();
            AtomicInteger ok = new AtomicInteger();
            AtomicInteger threw = new AtomicInteger();
            AtomicInteger wrongTarget = new AtomicInteger();
            CountDownLatch done = new CountDownLatch(n);

            for(int i = 0; i < n; i++){
                pool.submit(() -> {
                    try{
                        start.await();
                        Seq<SRVRecord> r = ArcDns.getSrvRecords(name);
                        if(r.size == 0) empty.incrementAndGet();
                        else ok.incrementAndGet();
                    }catch(Throwable t){
                        threw.incrementAndGet();
                    }finally{
                        done.countDown();
                    }
                });
            }
            start.countDown();
            done.await(60, TimeUnit.SECONDS);
            pool.shutdownNow();
            System.out.println(name);
            System.out.println("   queries=" + n + "  withRecord=" + ok.get() + "  EMPTY(lost/failed)=" + empty.get() + "  threw=" + threw.get());
        }
    }
}
