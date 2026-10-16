import rhino.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Compiles each top-level function of each mod script separately, to find out
 * which one trips Rhino's optimizer.
 *
 * The mod is split across scripts/main.js plus scripts/lib/*.js; this walks
 * them all, because a function that fails to compile takes the whole mod down
 * (the error surfaces as "the mod did not load", with no line number pointing
 * at the culprit).
 *
 * Usage: RhinoCheck <path to scripts/main.js>
 */
public class RhinoCheck{
    public static void main(String[] args) throws Exception{
        Path scripts = Paths.get(args[0]).toAbsolutePath().getParent();

        List<Path> js = new ArrayList<>();
        try(var stream = java.nio.file.Files.walk(scripts)){
            stream.filter(p -> p.toString().endsWith(".js")).sorted().forEach(js::add);
        }

        Context cx = Context.enter();
        cx.setOptimizationLevel(9);
        int bad = 0;

        for(Path file : js){
            String rel = scripts.relativize(file).toString();
            String src = new String(java.nio.file.Files.readAllBytes(file), StandardCharsets.UTF_8);
            String[] lines = src.split("\n", -1);

            List<Integer> starts = new ArrayList<>();
            for(int i = 0; i < lines.length; i++){
                if(lines[i].startsWith("function ")) starts.add(i);
            }
            starts.add(lines.length);

            for(int k = 0; k + 1 < starts.size(); k++){
                int from = starts.get(k), to = starts.get(k + 1);
                StringBuilder sb = new StringBuilder();
                for(int i = from; i < to; i++) sb.append(lines[i]).append('\n');
                String head = lines[from];
                String name = rel + ":" + (head.length() > 40 ? head.substring(0, 40) : head);
                try{
                    cx.compileString(sb.toString(), name, 1);
                    System.out.println("    OK   " + name + "   (" + (to - from) + " lines)");
                }catch(Throwable t){
                    bad++;
                    System.out.println("  FAIL   " + name + "   (" + (to - from) + " lines) -> " + t);
                }
            }
        }

        Context.exit();
        System.out.println(bad == 0 ? "ALL FUNCTIONS COMPILE" : bad + " FUNCTION(S) FAIL TO COMPILE");
        System.exit(bad == 0 ? 0 : 1);
    }
}
