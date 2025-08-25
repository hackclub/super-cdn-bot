declare global {
	namespace NodeJS {
		interface ProcessEnv {
			SLACK_BOT_TOKEN: string;
			SLACK_SIGNING_SECRET: string;
			SLACK_APP_TOKEN: string;
			CDN_URL: string;
			CDN_API_KEY: string;
			HOST_PORT: string;
			SERVER_PORT: string;
			SERVER_HOST: string;
			SERVER_PROTOCOL?: string;
		}
	}
}

export {};
