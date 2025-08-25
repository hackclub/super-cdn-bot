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
		const pathParts = url.pathname.slice(1).split("/");
		const fileId = pathParts[0];

		// Handle workflow button endpoint
		if (url.pathname === "/workflow-button") {
			return new Response(
				JSON.stringify({
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "Join the HQ channel (requires membership in prerequisite channel):",
							},
						},
						getJoinHQWorkflowButton(),
					],
				}),
				{
					headers: {
						"Content-Type": "application/json",
					},
				}
			);
		}

		// just here to make typescript happy :P
		if (!fileId) {
			return new Response("Invalid file path", { status: 400 });
		}

		const proxy = fileProxies.get(fileId);
		if (!proxy) {
			return new Response("File not found", { status: 404 });
		}

		fileProxies.delete(fileId);

		try {
			const response = await fetch(proxy, {
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			});

			if (!response.ok) {
				return new Response("Error fetching file", { status: response.status });
			}

			return new Response(response.body, {
				headers: {
					"Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
					"Content-Length": response.headers.get("Content-Length") || "",
				},
			});
		} catch (error) {
			return new Response("Error proxying file", { status: 500 });
		}
	},
});

console.log(`File proxy server running on port ${proxyPort}`);

// when the bot is added to a channel, send a message or leave if it wasn't the channel manager who added it
app.event("member_joined_channel", async ({ event, client }) => {
	if (event.user !== (await client.auth.test()).user_id) return; // only act when the bot is the one who got added

	try {
		const channelInfo = await client.conversations.info({ channel: event.channel });
		const inviterInfo = await client.users.info({ user: event.inviter! });

		const isChannelCreator = event.inviter === channelInfo.channel?.creator;
		const isWorkspaceAdmin = inviterInfo.user?.is_admin || inviterInfo.user?.is_owner;

		if (!isChannelCreator && event.inviter !== "U07FCRNHS1J" && !isWorkspaceAdmin) {
			await client.chat.postEphemeral({
				channel: event.channel,
				user: event.inviter!,
				text: `sorry, i'm leaving <#${event.channel}> because you're not the channel manager or workspace admin :(\nget the channel manager or workspace admin to add me!`,
			});
			await client.conversations.leave({ channel: event.channel });
		} else {
			await client.chat.postEphemeral({
				channel: event.channel,
				user: event.inviter!,
				text: "beep boop-- i'm up and running!",
			});
		}
	} catch (error) {
		console.error("Error handling channel join:", error);
	}
});

app.message(async ({ message, say }) => {
	if (!("files" in message) || !message.files?.length) return;

	const currentFileIDs: string[] = []; // keep track of the file IDs we generate so we can remove them later
	const proxyUrls = message.files.map(file => {
		if (!file.url_private) throw new Error("File missing private URL");
		const fileId = randomBytes(16).toString("hex");
		currentFileIDs.push(fileId);
		fileProxies.set(fileId, file.url_private);
		const proxyUrl = `${process.env.SERVER_URL}/${fileId}/${file.name || "file"}`;
		console.log(proxyUrl);
		return proxyUrl;
	});

	const loadingMessage = await say({
		text: ":loading-tumbleweed: uploady-ing...",
		thread_ts: message.ts,
	});

	try {
		const response = await ky
			.post(process.env.CDN_URL, {
				headers: {
					Authorization: `Bearer ${process.env.CDN_API_KEY}`,
					"Content-Type": "application/json",
				},
				json: proxyUrls,
			})
			.json<{
				files: Array<{
					deployedUrl: string;
					file: string;
					sha: string;
					size: number;
				}>;
				cdnBase: string;
			}>();

		const fileList = response.files.map(file => file.deployedUrl).join("\n");

		await app.client.chat.update({
			token: process.env.SLACK_BOT_TOKEN,
			channel: message.channel,
			ts: loadingMessage.ts!,
			text: `your files have been uploaded!\n${fileList}`,
		});
	} catch (error) {
		await app.client.chat.update({
			token: process.env.SLACK_BOT_TOKEN,
			channel: message.channel,
			ts: loadingMessage.ts!,
			text: `sorry, something went wrong :(\n\`\`\`\n${error}\n\`\`\`\n\ndm <@U07FCRNHS1J> about it?`,
		});
	} finally {
		// clean up the file URLs created on the proxy server
		// for (const id of currentFileIDs) {
		// 	fileProxies.delete(id);
		// }
	}
});

// Function to get the workflow button JSON (for use in bot description or workflows)
function getJoinHQWorkflowButton() {
	return {
		type: "actions",
		elements: [
			{
				type: "button",
				text: {
					type: "plain_text",
					text: "Join HQ Channel",
				},
				action_id: "join_hq_channel",
				style: "primary",
			},
		],
	};
}

// warning: everything below this point is vibecoded ai slop
app.action("join_hq_channel", async ({ ack, body, client }) => {
	await ack();

	const userId = body.user.id;
	const sourceChannelId = "G01QNNEUA10"; // hq-hq
	const targetChannelId = "C09C7L76UMP"; // hq-cdn

	try {
		// Check if user is in the source channel
		const members = await client.conversations.members({
			channel: sourceChannelId,
		});

		const isInSourceChannel = members.members?.includes(userId);

		if (!isInSourceChannel) {
			// User is not in the required channel
			await client.chat.postEphemeral({
				channel: body.channel?.id || userId,
				user: userId,
				text: "sorry, you're not in the club :<",
			});
			return;
		}

		// Check if user is already in target channel
		const targetMembers = await client.conversations.members({
			channel: targetChannelId,
		});

		const isAlreadyInTarget = targetMembers.members?.includes(userId);

		if (isAlreadyInTarget) {
			await client.chat.postEphemeral({
				channel: body.channel?.id || userId,
				user: userId,
				text: "you're already in <#C09C7L76UMP>!",
			});
			return;
		}

		// Add user to target channel
		await client.conversations.invite({
			channel: targetChannelId,
			users: userId,
		});

		// await client.chat.postEphemeral({
		// 	channel: body.channel?.id || userId,
		// 	user: userId,
		// 	text: "welcome!",
		// });
	} catch (error: any) {
		console.error("Error in join_hq_channel workflow:", error);

		// Handle specific error cases
		let errorMessage = "sorry, something went wrong. plz let <@U07FCRNHS1J> know.\nerror code: ";

		if (error?.data?.error === "channel_not_found") {
			errorMessage += "guh?";
		} else if (error?.data?.error === "user_not_found") {
			errorMessage += "wuh?";
		} else if (error?.data?.error === "not_in_channel") {
			errorMessage += "buh?";
		} else if (error?.data?.error === "cant_invite") {
			errorMessage +=
				"huh?";
		}

		await client.chat.postEphemeral({
			channel: body.channel?.id || userId,
			user: userId,
			text: errorMessage,
		});
	}
});

// Handle App Home tab view
app.event("app_home_opened", async ({ event, client }) => {
	try {
		await client.views.publish({
			user_id: event.user,
			view: {
				type: "home",
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "wanna use #hq-cdn?",
						},
					},
					getJoinHQWorkflowButton(),
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "(must be in #hq-hq)",
						},
					},
				],
			},
		});
	} catch (error) {
		console.error("Error publishing home view:", error);
	}
});

await app.start();
console.log("CDN bot is running!");
