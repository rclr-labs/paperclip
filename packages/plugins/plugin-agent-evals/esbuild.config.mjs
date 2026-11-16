import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// agent-evals-core pulls in `yaml`, a CommonJS package that calls require("process").
// esbuild's ESM output has no `require`; give the worker a real one.
const workerCtx = await esbuild.context({
  ...presets.esbuild.worker,
  banner: {
    ...presets.esbuild.worker.banner,
    js: [`import { createRequire as __agentEvalsCreateRequire } from "node:module";`, `const require = __agentEvalsCreateRequire(import.meta.url);`, presets.esbuild.worker.banner?.js ?? ""].join("\n"),
  },
});
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
