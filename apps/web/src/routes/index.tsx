import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: IndexPage,
});

function IndexPage() {
	return (
		<main className="flex items-center justify-center min-h-screen">
			<h1 className="text-2xl font-bold">ふあ Chat</h1>
		</main>
	);
}
