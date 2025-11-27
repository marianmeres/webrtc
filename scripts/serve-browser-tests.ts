#!/usr/bin/env -S deno run -A

import { join } from "@std/path";

const PORT = 8001;
const PROJECT_ROOT = Deno.cwd();

console.log(`Starting browser test server on http://localhost:${PORT}`);
console.log(`Open http://localhost:${PORT}/tests/browser/test-runner.html in your browser`);

Deno.serve({
	port: PORT,
	handler: async (req) => {
		const url = new URL(req.url);
		let filePath = url.pathname;

		// Default to test runner
		if (filePath === "/") {
			filePath = "/tests/browser/test-runner.html";
		}


		// Remove leading slash and resolve from project root
		const fsPath = join(PROJECT_ROOT, filePath.slice(1));

		try {
			const file = await Deno.readFile(fsPath);

			// Determine content type
			let contentType = "text/plain";
			if (fsPath.endsWith(".html")) contentType = "text/html";
			else if (fsPath.endsWith(".js")) contentType = "application/javascript";
			else if (fsPath.endsWith(".css")) contentType = "text/css";
			else if (fsPath.endsWith(".json")) contentType = "application/json";
			else if (fsPath.endsWith(".map")) contentType = "application/json";
			else if (fsPath.endsWith(".svg")) contentType = "image/svg+xml";

			return new Response(file, {
				headers: {
					"content-type": contentType,
					"cache-control": "no-cache",
				},
			});
		} catch (e) {
			console.error(`Error serving ${fsPath}:`, e.message);
			return new Response(`File not found: ${filePath}`, { status: 404 });
		}
	},
});
