import arc.net.dns.*;
import arc.struct.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class SrvGate{
    public static void main(String[] a) throws Exception{
        String name = "_mindustry._tcp.mdt-v4-srv.play.jiahai.top";
        int total = 400;
        for(int limit : new int[]{1, 2, 4, 8, 16, 64, 400}){
            Semaphore gate = new Semaphore(limit);
            ExecutorService pool = Executors.newFixedThreadPool(Math.min(limit, 64));
            AtomicInteger withRecord = new AtomicInteger(), empty = new AtomicInteger(), threw = new AtomicInteger();
            CountDownLatch done = new CountDownLatch(total);
            long start = System.currentTimeMillis();

            for(int i = 0; i < total; i++){
                pool.submit(() -> {
                    try{
                        gate.acquire();
                        try{
                            Seq<SRVRecord> r = ArcDns.getSrvRecords(name);
                            if(r.size == 0) empty.incrementAndGet(); else withRecord.incrementAndGet();
                        }finally{
                            gate.release();
                        }
                    }catch(Throwable t){
                        threw.incrementAndGet();
                    }finally{
                        done.countDown();
                    }
                });
            }
            done.await(300, TimeUnit.SECONDS);
            pool.shutdownNow();
            long ms = System.currentTimeMillis() - start;
            System.out.println("limit=" + limit + "  total=" + total + "  withRecord=" + withRecord.get()
                + "  EMPTY=" + empty.get() + "  threw=" + threw.get() + "  time=" + ms + "ms"
                + "   -> loss=" + (100 * empty.get() / total) + "%");
        }
    }
}
