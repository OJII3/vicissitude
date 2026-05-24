import { createFileRoute } from "@tanstack/react-router";
import type { VrmExpressionWeight } from "@vicissitude/shared/emotion";
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
		<main className="relative h-screen overflow-hidden bg-gray-100">
			{/* 3D アバター */}
			<div className="absolute inset-0">
				<VrmViewer expressionWeight={expressionWeight} />
			</div>

			{/* チャット */}
			<section className="pointer-events-none absolute inset-0 flex items-end justify-center p-3 sm:p-4 lg:items-stretch lg:justify-end lg:p-6">
				<div className="pointer-events-auto flex h-[46vh] min-h-0 w-full max-w-xl rounded-lg border border-white/30 bg-white/35 shadow-xl shadow-gray-900/10 backdrop-blur-md sm:h-[48vh] lg:h-full lg:max-w-md xl:max-w-lg">
					<ChatPanel onExpressionChange={handleExpressionChange} />
				</div>
			</section>
		</main>
	);
}
