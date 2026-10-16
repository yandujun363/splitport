import java.net.*;
import java.io.*;
import arc.net.dns.*;

/** Byte-level replay of ArcDns' answer walk, with correct header parsing. */
public class DnsDump{
    public static void main(String[] args) throws Exception{
        String domain = args[0];
        InetSocketAddress ns = new InetSocketAddress(args.length > 1 ? args[1] : "10.0.0.8", 53);

        // 1) show what ArcDns itself does
        System.out.println("--- ArcDns.getSrvRecords(" + domain + ") ---");
        try{
            var r = ArcDns.getSrvRecords(domain, ns);
            System.out.println("returned " + r.size + " records " + r);
        }catch(Throwable t){
            System.out.println("THREW " + t);
            StackTraceElement[] st = t.getStackTrace();
            for(int i = 0; i < Math.min(6, st.length); i++) System.out.println("    at " + st[i]);
        }

        // 2) raw bytes
        ByteArrayOutputStream stream = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(stream);
        out.writeShort(0x1234);
        out.writeShort(0x0100);
        out.writeShort(1); out.writeShort(0); out.writeShort(0); out.writeShort(0);
        for(String part : domain.split("\\.")){
            out.writeByte(part.length());
            out.write(part.getBytes("UTF-8"));
        }
        out.writeByte(0);
        out.writeShort(33);
        out.writeShort(1);

        byte[] response = new byte[512];
        int len;
        try(DatagramSocket socket = new DatagramSocket()){
            socket.setSoTimeout(3000);
            socket.send(new DatagramPacket(stream.toByteArray(), stream.size(), ns));
            DatagramPacket packet = new DatagramPacket(response, response.length);
            socket.receive(packet);
            len = packet.getLength();
        }
        System.out.println("--- raw response (" + len + " bytes) ---");
        for(int i = 0; i < len; i += 16){
            StringBuilder line = new StringBuilder(String.format("%04d  ", i));
            StringBuilder ascii = new StringBuilder();
            for(int j = i; j < Math.min(len, i + 16); j++){
                line.append(String.format("%02x ", response[j] & 0xff));
                int c = response[j] & 0xff;
                ascii.append(c >= 32 && c < 127 ? (char)c : '.');
            }
            System.out.println(line + " " + ascii);
        }

        // 3) replay ArcDns' walk faithfully
        System.out.println("--- replaying ArcDns' walk ---");
        try(DataInputStream in = new DataInputStream(new ByteArrayInputStream(response))){
            in.readShort();
            in.readShort();
            in.readShort();                              // qdcount
            int answers = in.readUnsignedShort();
            in.readShort(); in.readShort();
            System.out.println("ancount = " + answers);

            byte l;
            while((l = in.readByte()) != 0){ in.skipBytes(l); }
            in.readShort(); in.readShort();

            for(int i = 0; i < answers; i++){
                int off = in.readShort();
                int type = in.readShort();
                int cls = in.readShort();
                long ttl = in.readInt() & 0xFFFFFFFFL;
                int rdlen = in.readUnsignedShort();
                String typeName = type == 5 ? "CNAME" : type == 33 ? "SRV" : type == 1 ? "A" : "" + type;
                System.out.printf("RR#%d @name=0x%04x type=%s class=%d ttl=%d rdlength=%d%n", i, off & 0xffff, typeName, cls, ttl, rdlen);
                int priority = in.readUnsignedShort();
                int weight = in.readUnsignedShort();
                int port = in.readUnsignedShort();
                System.out.printf("    ArcDns takes prio=%d weight=%d port=%d from the first 6 rdata bytes%n", priority, weight, port);
                StringBuilder builder = new StringBuilder();
                try{
                    while((l = in.readByte()) != 0){
                        for(int j = 0; j < l; j++) builder.append((char)in.readByte());
                        builder.append('.');
                    }
                }catch(Exception e){
                    System.out.printf("    name walk threw %s (builder='%s', length %d)%n", e, builder, builder.length());
                    break;
                }
                System.out.printf("    name walk produced '%s' (length %d)%n", builder, builder.length());
                try{
                    builder.delete(builder.length() - 1, builder.length());
                    System.out.println("    delete() ok -> '" + builder + "'");
                }catch(Exception e){
                    System.out.printf("    delete(-1,0) THREW %s%n", e);
                    break;
                }
            }
        }
    }
}
