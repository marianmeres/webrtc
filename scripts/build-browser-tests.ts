#!/usr/bin/env -S deno run -A

import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/mod.js";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@^0.10.3";
import { resolve } from "@std/path";

console.log("Building browser tests...");

const result = await esbuild.build({
	plugins: [
		...denoPlugins({
			configPath: resolve(Deno.cwd(), "deno.json"),
		}),
	],
	entryPoints: ["./tests/browser/p2p-tests.ts"],
	outfile: "./tests/browser/p2p-tests.js",
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2020",
	minify: false,
	sourcemap: true,
});

console.log("Browser tests built successfully!");

esbuild.stop();
