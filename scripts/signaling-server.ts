#!/usr/bin/env -S deno run --allow-net --allow-read

/**
 * Simple HTTP signaling server for WebRTC testing across different browsers.
 * Stores signaling data in memory and serves it via REST API.
 *
 * Usage:
 *   deno run --allow-net --allow-read scripts/signaling-server.ts
 *
 * Then access:
 *   http://localhost:8000/audio-peer1.html
 *   http://localhost:8000/audio-peer2.html (in different browser)
 */

interface SignalingData {
	offer?: RTCSessionDescriptionInit;
	answer?: RTCSessionDescriptionInit;
	iceCandidates1: RTCIceCandidateInit[];
	iceCandidates2: RTCIceCandidateInit[];
	lastUpdate: number;
}

// In-memory storage for signaling data
const sessions = new Map<string, SignalingData>();
const SESSION_TIMEOUT = 3600000; // 1 hour

// Cleanup old sessions periodically
setInterval(() => {
	const now = Date.now();
	for (const [id, data] of sessions.entries()) {
		if (now - data.lastUpdate > SESSION_TIMEOUT) {
			sessions.delete(id);
			console.log(`[Cleanup] Removed session: ${id}`);
		}
	}
}, 60000); // Every minute

function getSession(id: string): SignalingData {
	if (!sessions.has(id)) {
		sessions.set(id, {
			iceCandidates1: [],
			iceCandidates2: [],
			lastUpdate: Date.now(),
		});
		console.log(`[Session] Created new session: ${id}`);
	}
	return sessions.get(id)!;
}

async function handleRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const corsHeaders = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	};

	// Handle CORS preflight
	if (req.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders });
	}

	// Serve static files from example directory
	if (url.pathname.startsWith("/audio-peer")) {
		try {
			const filePath = `./example${url.pathname}`;
			const content = await Deno.readTextFile(filePath);
			const contentType = url.pathname.endsWith(".html")
				? "text/html"
				: url.pathname.endsWith(".js")
				? "application/javascript"
				: "text/plain";

			return new Response(content, {
				headers: { "Content-Type": contentType, ...corsHeaders },
			});
		} catch {
			return new Response("Not Found", { status: 404, headers: corsHeaders });
		}
	}

	// API endpoints for signaling
	const apiMatch = url.pathname.match(/^\/api\/session\/([^\/]+)\/(.+)$/);

	if (apiMatch) {
		const [, sessionId, action] = apiMatch;
		const session = getSession(sessionId);
		session.lastUpdate = Date.now();

		if (req.method === "POST") {
			const body = await req.json();

			switch (action) {
				case "offer":
					session.offer = body;
					console.log(`[Session ${sessionId}] Offer stored`);
					return new Response(JSON.stringify({ ok: true }), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});

				case "answer":
					session.answer = body;
					console.log(`[Session ${sessionId}] Answer stored`);
					return new Response(JSON.stringify({ ok: true }), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});

				case "ice1":
					session.iceCandidates1.push(body);
					console.log(
						`[Session ${sessionId}] ICE candidate 1 stored (total: ${session.iceCandidates1.length})`,
					);
					return new Response(JSON.stringify({ ok: true }), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});

				case "ice2":
					session.iceCandidates2.push(body);
					console.log(
						`[Session ${sessionId}] ICE candidate 2 stored (total: ${session.iceCandidates2.length})`,
					);
					return new Response(JSON.stringify({ ok: true }), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
			}
		} else if (req.method === "GET") {
			switch (action) {
				case "offer":
					return new Response(JSON.stringify(session.offer || null), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});

				case "answer":
					return new Response(JSON.stringify(session.answer || null), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});

				case "ice1":
					const ice1 = session.iceCandidates1;
					session.iceCandidates1 = []; // Clear after reading
					return new Response(JSON.stringify(ice1), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});

				case "ice2":
					const ice2 = session.iceCandidates2;
					session.iceCandidates2 = []; // Clear after reading
					return new Response(JSON.stringify(ice2), {
						headers: { "Content-Type": "application/json", ...corsHeaders },
					});
			}
		} else if (req.method === "DELETE" && action === "reset") {
			sessions.delete(sessionId);
			console.log(`[Session ${sessionId}] Reset/deleted`);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json", ...corsHeaders },
			});
		}
	}

	// Status endpoint
	if (url.pathname === "/api/status") {
		return new Response(
			JSON.stringify({
				activeSessions: sessions.size,
				sessions: Array.from(sessions.keys()),
			}),
			{
				headers: { "Content-Type": "application/json", ...corsHeaders },
			},
		);
	}

	return new Response("Not Found", { status: 404, headers: corsHeaders });
}

const PORT = 8000;
console.log(`
🚀 WebRTC Signaling Server started!

   Local:    http://localhost:${PORT}/

📝 Usage:
   1. Open http://localhost:${PORT}/audio-peer1.html in Chrome
   2. Open http://localhost:${PORT}/audio-peer2.html in Firefox
   3. Select "HTTP Server" as signaling mode in both
   4. Follow the testing steps

🔍 Server status: http://localhost:${PORT}/api/status

Press Ctrl+C to stop
`);

Deno.serve({ port: PORT }, handleRequest);
