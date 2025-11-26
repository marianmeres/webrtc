import * as esbuild from "https://deno.land/x/esbuild@v0.20.0/mod.js";
import { denoPlugins } from "https://deno.land/x/esbuild_deno_loader@0.9.0/mod.ts";
import { resolve } from "https://deno.land/std@0.203.0/path/mod.ts";

const configPath = resolve("./deno.json");

await esbuild.build({
	plugins: [...denoPlugins({ configPath })],
	entryPoints: [
		"./example/main.ts",
		"./example/p2p.ts",
		"./example/peer.ts",
		"./example/audio-peer.ts",
	],
	outdir: "./example",
	bundle: true,
	format: "esm",
});

await esbuild.stop();
console.log("Build complete");
