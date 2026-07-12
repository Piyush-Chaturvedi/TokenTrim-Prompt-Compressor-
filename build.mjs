import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/background/service-worker.js"],
  bundle: true,
  outfile: "dist/service-worker.bundle.js",
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching src/background/ for changes...");
} else {
  await esbuild.build(options);
  console.log("Built dist/service-worker.bundle.js");
}
