import arc.net.dns.*;
import arc.struct.Seq;
import java.net.*;

public class DnsCheck{
    public static void main(String[] args) throws Exception{
        System.out.println("auto nameservers: " + ArcDns.getNameservers());
        String[] domains = {"mdt-v4-srv.play.jiahai.top", "mdt-v4-srv.play.336456301.xyz"};
        for(String d : domains){
            for(String kind : new String[]{"_mindustry._tcp.", "_mindustry._udp."}){
                String name = kind + d;
                System.out.println("=== " + name);
                long t0 = System.nanoTime();
                try{
                    Seq<SRVRecord> r = ArcDns.getSrvRecords(name, new InetSocketAddress("10.0.0.8", 53));
                    System.out.println("  direct-10.0.0.8: " + r.size + " records in " + (System.nanoTime()-t0)/1000000 + "ms");
                    for(int i = 0; i < r.size; i++){
                        SRVRecord rec = r.get(i);
                        System.out.println("    ttl=" + rec.ttl + " prio=" + rec.priority + " weight=" + rec.weight + " port=" + rec.port + " target='" + rec.target + "'");
                    }
                }catch(Exception e){
                    System.out.println("  direct-10.0.0.8 EXC " + e);
                }
                try{
                    Seq<SRVRecord> r = ArcDns.getSrvRecords(name);
                    System.out.println("  auto: " + r.size + " records");
                    for(int i = 0; i < r.size; i++){
                        SRVRecord rec = r.get(i);
                        System.out.println("    port=" + rec.port + " target='" + rec.target + "'");
                    }
                }catch(Exception e){
                    System.out.println("  auto EXC " + e);
                }
            }
        }
    }
}
