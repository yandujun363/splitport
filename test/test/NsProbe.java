import arc.net.dns.*;
import arc.struct.*;
public class NsProbe{
    public static void main(String[] a){
        String name = "_mindustry._tcp.mdt-v4-srv.play.jiahai.top";
        for(java.net.InetSocketAddress ns : ArcDns.getNameservers()){
            long s = System.currentTimeMillis();
            try{
                Seq<SRVRecord> r = ArcDns.getSrvRecords(name, ns);
                System.out.println(ns + " -> " + r.size + " record(s) in " + (System.currentTimeMillis() - s) + "ms");
            }catch(Exception e){
                System.out.println(ns + " -> FAILED after " + (System.currentTimeMillis() - s) + "ms: " + e);
            }
        }
    }
}
