import type { VrmExpressionWeight } from "@vicissitude/shared/emotion";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { VrmViewer } from "../components/avatar/VrmViewer";
import { ChatPanel } from "../components/chat/ChatPanel";

export const Route = createFileRoute("/")({
	component: IndexPage,
});

function IndexPage() {
	const [expressionWeight, setExpressionWeight] = useState<VrmExpressionWeight | null>(null);

	const handleExpressionChange = useCallback((weight: VrmExpressionWeight) => {
		setExpressionWeight(weight);
	}, []);

	return (
		<main className="flex h-screen flex-col lg:flex-row">
			{/* 3D アバター */}
			<div className="h-1/2 w-full lg:h-full lg:w-1/2 bg-gray-100">
				<VrmViewer expressionWeight={expressionWeight} />
			</div>

			{/* チャット */}
			<div className="h-1/2 w-full lg:h-full lg:w-1/2 bg-white">
				<ChatPanel onExpressionChange={handleExpressionChange} />
			</div>
		</main>
	);
}
