/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_GATEWAY_PORT?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
