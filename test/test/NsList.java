import arc.net.dns.*;
import arc.struct.*;
public class NsList{
    public static void main(String[] a){
        Seq<java.net.InetSocketAddress> ns = ArcDns.getNameservers();
        System.out.println("nameservers: " + ns.size);
        for(int i = 0; i < ns.size; i++) System.out.println("   " + ns.get(i));
    }
}
