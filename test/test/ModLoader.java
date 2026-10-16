import rhino.*;
import rhino.module.*;
import rhino.module.provider.*;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

/**
 * Loads a mod the way Mindustry does.
 *
 * mindustry.mod.Scripts installs a CommonJS require (rhino.module.RequireBuilder
 * + a provider that resolves ids against the mod's scripts/ directory) and then
 * evaluates main.js inside "(function(){'use strict'; ... })()". Anything a mod
 * wants from another file has to be pulled in with require() from its top level,
 * because the game only ever runs main.js.
 *
 * The harness has to reproduce that, otherwise it would test a code path the
 * game never takes.
 */
public class ModLoader{

    /** Installs require() on an existing scope (one that already ran global.js). */
    public static void installRequire(Context cx, Scriptable scope, File scriptsDir){
        new RequireBuilder()
            .setModuleScriptProvider(new SoftCachingModuleScriptProvider(new DirProvider(scriptsDir)))
            .setSandboxed(true)
            .createRequire(cx, scope)
            .install(scope);
    }

    /** Installs require() and runs scripts/main.js, exactly like Mods.loadScripts. */
    public static void runMod(Context cx, Scriptable scope, File scriptsDir, String modName) throws IOException{
        installRequire(cx, scope, scriptsDir);

        String main = new String(java.nio.file.Files.readAllBytes(
            new File(scriptsDir, "main.js").toPath()), StandardCharsets.UTF_8);

        cx.evaluateString(scope, "modName = \"" + modName + "\"; scriptName = \"main.js\";", "initscript.js", 1);
        cx.evaluateString(scope, "(function(){'use strict';\n" + main + "\n})();", "main.js", 1);
    }

    /** Convenience: scripts directory that mainJs lives in. */
    public static File scriptsDirOf(String mainJs){
        File parent = new File(mainJs).getAbsoluteFile().getParentFile();
        return parent == null ? new File(".") : parent;
    }

    /** Resolves require ids against a plain directory (the game resolves them
     *  against the loaded mod's scripts/ directory). */
    static class DirProvider extends UrlModuleSourceProvider{
        final File root;

        DirProvider(File root){
            super(null, null);
            this.root = root;
        }

        @Override
        public ModuleSource loadSource(String moduleId, Scriptable paths, Object validator)
            throws IOException, URISyntaxException{
            File file = new File(root, moduleId + ".js");
            if(!file.isFile()) return null;
            return new ModuleSource(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8),
                file.toURI(), root.toURI(), validator);
        }
    }
}
