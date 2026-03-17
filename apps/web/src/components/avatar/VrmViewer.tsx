import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { VRM } from "@pixiv/three-vrm";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { VrmExpressionWeight } from "@vicissitude/shared/emotion";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ─── Auto Blink ─────────────────────────────────────────────────

const BLINK_INTERVAL_MIN = 2000;
const BLINK_INTERVAL_MAX = 6000;
const BLINK_DURATION = 120;

function useAutoBlink(vrm: VRM | null) {
	const blinkingRef = useRef(false);

	useEffect(() => {
		if (!vrm) return;

		let timeoutId: ReturnType<typeof setTimeout>;

		function scheduleNextBlink() {
			const delay = BLINK_INTERVAL_MIN + Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN);
			timeoutId = setTimeout(() => {
				blinkingRef.current = true;
				setTimeout(() => {
					blinkingRef.current = false;
					scheduleNextBlink();
				}, BLINK_DURATION);
			}, delay);
		}

		scheduleNextBlink();
		return () => clearTimeout(timeoutId);
	}, [vrm]);

	return blinkingRef;
}

// ─── VRM Loader Hook ────────────────────────────────────────────

function useVrmLoader(url: string, onError: (message: string) => void, onLoaded: () => void) {
	const [vrm, setVrm] = useState<VRM | null>(null);
	const { scene } = useThree();

	useEffect(() => {
		const loader = new GLTFLoader();
		loader.register((parser) => new VRMLoaderPlugin(parser));

		let disposed = false;

		loader.load(
			url,
			(gltf) => {
				if (disposed) return;
				const loadedVrm = gltf.userData["vrm"] as VRM | undefined;
				if (!loadedVrm) {
					onError("VRM データが見つかりません");
					return;
				}
				VRMUtils.removeUnnecessaryJoints(gltf.scene);
				VRMUtils.removeUnnecessaryVertices(gltf.scene);
				VRMUtils.rotateVRM0(loadedVrm);
				scene.add(loadedVrm.scene);
				setVrm(loadedVrm);
				onLoaded();
			},
			undefined,
			() => {
				if (disposed) return;
				onError("モデルの読み込みに失敗しました");
			},
		);

		return () => {
			disposed = true;
			if (vrm) {
				scene.remove(vrm.scene);
				VRMUtils.deepDispose(vrm.scene);
			}
		};
	}, [url]);

	return vrm;
}

// ─── Expression Sync Hook ───────────────────────────────────────

const EXPRESSION_NAMES = ["happy", "angry", "sad", "relaxed", "surprised"] as const;

function useExpressionSync(vrm: VRM | null, expressionWeight: VrmExpressionWeight | null) {
	useEffect(() => {
		if (!vrm?.expressionManager) return;
		for (const name of EXPRESSION_NAMES) {
			vrm.expressionManager.setValue(name, 0);
		}
		if (expressionWeight && expressionWeight.expression !== "neutral") {
			vrm.expressionManager.setValue(expressionWeight.expression, expressionWeight.weight);
		}
	}, [vrm, expressionWeight]);
}

// ─── VRM Scene (Canvas 内部) ────────────────────────────────────

interface VrmSceneProps {
	url: string;
	expressionWeight: VrmExpressionWeight | null;
	onError: (message: string) => void;
	onLoaded: () => void;
}

function VrmScene({ url, expressionWeight, onError, onLoaded }: VrmSceneProps) {
	const vrm = useVrmLoader(url, onError, onLoaded);
	const blinkingRef = useAutoBlink(vrm);
	const clockRef = useRef(new THREE.Clock());

	useExpressionSync(vrm, expressionWeight);

	useFrame(() => {
		if (!vrm) return;
		const delta = clockRef.current.getDelta();
		vrm.update(delta);
		if (vrm.expressionManager) {
			vrm.expressionManager.setValue("blink", blinkingRef.current ? 1 : 0);
		}
	});

	return null;
}

// ─── VrmViewer (公開コンポーネント) ─────────────────────────────

interface VrmViewerProps {
	modelUrl?: string;
	expressionWeight: VrmExpressionWeight | null;
}

export function VrmViewer({ modelUrl = "/models/sample.vrm", expressionWeight }: VrmViewerProps) {
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
