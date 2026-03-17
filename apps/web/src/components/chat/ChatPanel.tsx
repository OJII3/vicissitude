import type { VrmExpressionWeight } from "@vicissitude/shared/emotion";
import type { ServerMessage } from "@vicissitude/shared/ws-protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { WsClient } from "../../lib/ws-client";

// ─── Types ──────────────────────────────────────────────────────

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
}

interface ChatPanelProps {
	onExpressionChange: (expressionWeight: VrmExpressionWeight) => void;
}

// ─── Constants ──────────────────────────────────────────────────

function getWsUrl(): string {
	const host = window.location.hostname;
	const port = import.meta.env.VITE_GATEWAY_PORT ?? "4001";
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${host}:${port}/ws`;
}

// ─── WS Hook ────────────────────────────────────────────────────

function useWsConnection(onExpressionChange: (w: VrmExpressionWeight) => void) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [connected, setConnected] = useState(false);
	const clientRef = useRef<WsClient | null>(null);
	const expressionRef = useRef(onExpressionChange);
	expressionRef.current = onExpressionChange;

	useEffect(() => {
		const client = new WsClient(getWsUrl());
		clientRef.current = client;

		const unsubMessage = client.onMessage((message: ServerMessage) => {
			if (message.type === "chat_message") {
				if (message.status === "complete") {
					setMessages((prev) => [
						...prev,
						{ id: message.messageId, role: "assistant", text: message.text },
					]);
				}
			} else if (message.type === "emotion_update") {
				expressionRef.current(message.expressionWeight);
			}
		});
		const unsubOpen = client.onOpen(() => setConnected(true));
		const unsubClose = client.onClose(() => setConnected(false));

		client.connect();

		return () => {
			unsubMessage();
			unsubOpen();
			unsubClose();
			client.disconnect();
		};
	}, []);

	return { messages, setMessages, connected, clientRef };
}

// ─── Sub-components ─────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
	return (
		<div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
					msg.role === "user" ? "bg-blue-500 text-white" : "bg-gray-200 text-gray-800"
				}`}
			>
				{msg.text}
			</div>
		</div>
	);
}

// ─── Message List ───────────────────────────────────────────────

function MessageList({ messages }: { messages: ChatMessage[] }) {
	const messagesEndRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	return (
		<div className="flex-1 overflow-y-auto p-4 space-y-3">
			{messages.length === 0 && (
				<p className="text-center text-sm text-gray-400">メッセージを送信してください</p>
			)}
			{messages.map((msg) => (
				<MessageBubble key={msg.id} msg={msg} />
			))}
			<div ref={messagesEndRef} />
		</div>
	);
}

// ─── Chat Input ─────────────────────────────────────────────────

interface ChatInputProps {
	onSend: (text: string) => void;
}

function ChatInput({ onSend }: ChatInputProps) {
	const [input, setInput] = useState("");

	const handleSend = useCallback(() => {
		const trimmed = input.trim();
		if (!trimmed) return;
		onSend(trimmed);
		setInput("");
	}, [input, onSend]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend],
	);

	return (
		<div className="border-t border-gray-200 p-3">
			<div className="flex gap-2">
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="メッセージを入力..."
					className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
				/>
				<button
					type="button"
					onClick={handleSend}
					disabled={!input.trim()}
					className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					送信
				</button>
			</div>
		</div>
	);
}

// ─── Component ──────────────────────────────────────────────────

export function ChatPanel({ onExpressionChange }: ChatPanelProps) {
	const { messages, setMessages, connected, clientRef } = useWsConnection(onExpressionChange);

	const handleSend = useCallback(
		(text: string) => {
			if (!clientRef.current) return;
			setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text }]);
			clientRef.current.send({
				type: "chat_input",
				text,
				timestamp: new Date().toISOString(),
			});
		},
		[clientRef, setMessages],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
				<h2 className="text-lg font-semibold">Chat</h2>
				<span
					className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
					title={connected ? "接続中" : "未接続"}
				/>
			</div>
			<MessageList messages={messages} />
			<ChatInput onSend={handleSend} />
		</div>
	);
}
