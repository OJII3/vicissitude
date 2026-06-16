import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import type { VrmExpressionWeight } from "@vicissitude/shared/emotion";
import { Suspense, useCallback, useRef, useState } from "react";
import * as THREE from "three";

import { DEFAULT_AVATAR_MODEL_URL, DEFAULT_IDLE_ANIMATION_URL } from "./avatar-assets";
import { useAutoBlink } from "./hooks/use-auto-blink";
import { useExpressionSync } from "./hooks/use-expression-sync";
import { useVrmAnimation } from "./hooks/use-vrm-animation";
import { useVrmLoader } from "./hooks/use-vrm-loader";

// ─── VRM Scene (Canvas 内部) ────────────────────────────────────

interface VrmSceneProps {
	url: string;
	animationUrl: string;
	expressionWeight: VrmExpressionWeight | null;
	onError: (message: string) => void;
	onLoaded: () => void;
}

function VrmScene({ url, animationUrl, expressionWeight, onError, onLoaded }: VrmSceneProps) {
	const vrm = useVrmLoader(url, onError, onLoaded);
	const animationMixer = useVrmAnimation(vrm, animationUrl, onError);
	const blinkingRef = useAutoBlink(vrm);
	const timerRef = useRef(new THREE.Timer());

	useExpressionSync(vrm, expressionWeight);

	useFrame(() => {
		if (!vrm) return;
		timerRef.current.update();
		const delta = timerRef.current.getDelta();
		animationMixer?.update(delta);
		if (vrm.expressionManager) {
			vrm.expressionManager.setValue("blink", blinkingRef.current ? 1 : 0);
		}
		vrm.update(delta);
	});

	return null;
}

// ─── VrmViewer (公開コンポーネント) ─────────────────────────────

interface VrmViewerProps {
	modelUrl?: string;
	animationUrl?: string;
	expressionWeight: VrmExpressionWeight | null;
}

export function VrmViewer({
	modelUrl = DEFAULT_AVATAR_MODEL_URL,
	animationUrl = DEFAULT_IDLE_ANIMATION_URL,
	expressionWeight,
}: VrmViewerProps) {
	const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
	const [errorMessage, setErrorMessage] = useState("");

	const handleError = useCallback((message: string) => {
		setErrorMessage(message);
		setStatus("error");
	}, []);

	const handleLoaded = useCallback(() => {
		setStatus("loaded");
	}, []);

	return (
		<div className="relative h-full w-full">
			{status === "loading" && (
				<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100 text-gray-500">
					モデルを読み込み中...
				</div>
			)}
			{status === "error" && (
				<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100 text-red-500">
					{errorMessage}
				</div>
			)}
			<Canvas camera={{ position: [0, 1.2, 1.5], fov: 35 }}>
				<ambientLight intensity={0.8} />
				<directionalLight position={[1, 2, 1]} intensity={1.2} />
				<Suspense fallback={null}>
					<VrmScene
						url={modelUrl}
						animationUrl={animationUrl}
						expressionWeight={expressionWeight}
						onError={handleError}
						onLoaded={handleLoaded}
					/>
				</Suspense>
				<OrbitControls target={[0, 1, 0]} />
			</Canvas>
		</div>
	);
}
