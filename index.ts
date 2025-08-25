import { App } from "@slack/bolt";
import ky from "ky";
import { serve } from "bun";
import { randomBytes } from "crypto";

const fileProxies = new Map<string, string>();

const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	signingSecret: process.env.SLACK_SIGNING_SECRET,
	socketMode: true,
	appToken: process.env.SLACK_APP_TOKEN,
});

// Start web server for file proxying
// slack file URLs aren't accessible without auth, so this runs
// a server that proxies requests with the bot token
const proxyPort = parseInt(process.env.HOST_PORT);
const server = serve({
	port: proxyPort,
	async fetch(req) {
		const url = new URL(req.url);
		const fileId = url.pathname.slice(1);
		
		const proxy = fileProxies.get(fileId);
		if (!proxy) {
			console.log(`Proxy not found for file ID: ${fileId}`);
			return new Response("File not found", { status: 404 });
		}
		
		console.log(`Proxying file ${fileId} from ${proxy}`);
		fileProxies.delete(fileId);
		
		try {
			const response = await fetch(proxy, {
				headers: {
					'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
				}
			});
			
			if (!response.ok) {
				return new Response("Error fetching file", { status: response.status });
			}
			
			return new Response(response.body, {
				headers: {
					'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
					'Content-Length': response.headers.get('Content-Length') || '',
				}
			});
		} catch (error) {
			return new Response("Error proxying file", { status: 500 });
		}
	}
});

console.log(`File proxy server running on port ${proxyPort}`);

app.message(async ({ message, say }) => {
	if (message.channel !== process.env.CHANNEL_ID) return;
	if (!("files" in message) || !message.files?.length) return;

	const currentFileIDs: string[] = []; // keep track of the file IDs we generate so we can remove them later
	const proxyUrls = message.files.map(file => {
		if (!file.url_private) throw new Error("File missing private URL");
		const fileId = randomBytes(16).toString('hex');
		currentFileIDs.push(fileId)
		fileProxies.set(fileId, file.url_private);
		const proxyUrl = `${process.env.SERVER_PROTOCOL || "https"}://${process.env.SERVER_HOST}:${process.env.SERVER_PORT}/${fileId}`;
		return proxyUrl;
	});
	
	const loadingMessage = await say({
		text: ":loading-tumbleweed: uploady-ing...",
		thread_ts: message.ts
	});

	try {
		const response = await ky.post(process.env.CDN_URL, {
			headers: {
				'Authorization': `Bearer ${process.env.CDN_API_KEY}`,
				'Content-Type': 'application/json'
			},
			json: proxyUrls
		}).json<{
			files: Array<{
				deployedUrl: string;
				file: string;
				sha: string;
				size: number;
			}>;
			cdnBase: string;
		}>();

		const fileList = response.files.map(file => file.deployedUrl).join('\n');
		
		await app.client.chat.update({
			token: process.env.SLACK_BOT_TOKEN,
			channel: message.channel,
			ts: loadingMessage.ts!,
			text: `your files have been uploaded!\n${fileList}`
		});
	} catch (error) {
		await app.client.chat.update({
			token: process.env.SLACK_BOT_TOKEN,
			channel: message.channel,
			ts: loadingMessage.ts!,
			text: `sorry, something went wrong :(\n\`\`\`\n${error}\n\`\`\`\n\ndm <@U07FCRNHS1J> about it?`
		});
	} finally { // clean up the file URLs created on the proxy server
		for (const id of currentFileIDs) {
			fileProxies.delete(id);
		}
	}
	
});

await app.start();
console.log("CDN bot is running!");
