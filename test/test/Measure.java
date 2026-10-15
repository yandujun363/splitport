import arc.net.dns.*;
import arc.struct.*;
import java.net.*;
import java.nio.*;

public class Measure{
    public static void main(String[] a) throws Exception{
        String target = "openwrt.4.ip.336456301.xyz";
        String domain = "mdt-v4-srv.play.jiahai.top";
        int udpPort = 23467;

        long t0 = System.nanoTime();
        InetAddress addr = InetAddress.getByName(target);
        long dns = (System.nanoTime() - t0) / 1_000_000;
        System.out.println("getByName(" + target + ") = " + addr.getHostAddress() + "  took " + dns + "ms");

        for(int i = 0; i < 4; i++){
            long s = System.nanoTime();
            try(DatagramSocket sock = new DatagramSocket()){
                sock.send(new DatagramPacket(new byte[]{-2, 1}, 2, addr, udpPort));
                sock.setSoTimeout(3000);
                DatagramPacket p = new DatagramPacket(new byte[1024], 1024);
                sock.receive(p);
                System.out.println("  udp ping #" + i + " rtt = " + (System.nanoTime() - s) / 1_000_000 + "ms, reply " + p.getLength() + " bytes");
            }catch(Exception e){
                System.out.println("  udp ping #" + i + " FAILED after " + (System.nanoTime() - s) / 1_000_000 + "ms: " + e);
            }
        }

        for(String q : new String[]{"_mindustry._udp." + domain, "_mindustry._tcp." + domain}){
            long s = System.nanoTime();
            Seq<SRVRecord> recs = ArcDns.getSrvRecords(q);
            System.out.println("srv " + q + " -> " + recs.size + " record(s) in " + (System.nanoTime() - s) / 1_000_000 + "ms  " + recs);
        }
    }
}
