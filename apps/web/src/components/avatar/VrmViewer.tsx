import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { VRM } from "@pixiv/three-vrm";
import {
	createVRMAnimationClip,
	VRMAnimationLoaderPlugin,
	type VRMAnimation,
} from "@pixiv/three-vrm-animation";
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { VrmExpressionWeight } from "@vicissitude/shared/emotion";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { DEFAULT_AVATAR_MODEL_URL, DEFAULT_IDLE_ANIMATION_URL } from "./avatar-assets";
import { syncVrmExpression } from "./expression-sync";

// ─── Auto Blink ─────────────────────────────────────────────────

const BLINK_INTERVAL_MIN = 2000;
const BLINK_INTERVAL_MAX = 6000;
const BLINK_DURATION = 120;

function useAutoBlink(vrm: VRM | null) {
	const blinkingRef = useRef(false);

	useEffect(() => {
		if (!vrm) return;

		let cancelled = false;
		let outerTimeout: ReturnType<typeof setTimeout>;
		let innerTimeout: ReturnType<typeof setTimeout>;

		function scheduleNextBlink() {
			const delay = BLINK_INTERVAL_MIN + Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN);
			outerTimeout = setTimeout(() => {
				if (cancelled) return;
				blinkingRef.current = true;
				innerTimeout = setTimeout(() => {
					if (cancelled) return;
					blinkingRef.current = false;
					scheduleNextBlink();
				}, BLINK_DURATION);
			}, delay);
		}

		scheduleNextBlink();
		return () => {
			cancelled = true;
			clearTimeout(outerTimeout);
			clearTimeout(innerTimeout);
		};
	}, [vrm]);

	return blinkingRef;
}

// ─── VRM Loader Hook ────────────────────────────────────────────

interface VrmLoadContext {
	disposed: boolean;
	scene: THREE.Scene;
	vrmRef: React.RefObject<VRM | null>;
	setVrm: (vrm: VRM) => void;
	onErrorRef: React.RefObject<(message: string) => void>;
	onLoadedRef: React.RefObject<() => void>;
}

function handleVrmLoad(
	gltf: { userData: Record<string, unknown>; scene: THREE.Object3D },
	ctx: VrmLoadContext,
) {
	if (ctx.disposed) return;
	const loadedVrm = gltf.userData["vrm"] as VRM | undefined;
	if (!loadedVrm) {
		ctx.onErrorRef.current("VRM データが見つかりません");
		return;
	}
	VRMUtils.combineSkeletons(gltf.scene);
	VRMUtils.removeUnnecessaryVertices(gltf.scene);
	VRMUtils.rotateVRM0(loadedVrm);
	ctx.scene.add(loadedVrm.scene);
	ctx.vrmRef.current = loadedVrm;
	ctx.setVrm(loadedVrm);
	ctx.onLoadedRef.current();
}

function useVrmLoader(url: string, onError: (message: string) => void, onLoaded: () => void) {
	const [vrm, setVrm] = useState<VRM | null>(null);
	const vrmRef = useRef<VRM | null>(null);
	const { scene } = useThree();
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;
	const onLoadedRef = useRef(onLoaded);
	onLoadedRef.current = onLoaded;

	useEffect(() => {
		const loader = new GLTFLoader();
		loader.register((parser) => new VRMLoaderPlugin(parser));
		const ctx: VrmLoadContext = { disposed: false, scene, vrmRef, setVrm, onErrorRef, onLoadedRef };

		loader.load(
			url,
			(gltf) => handleVrmLoad(gltf, ctx),
			undefined,
			() => {
				if (!ctx.disposed) onErrorRef.current("モデルの読み込みに失敗しました");
			},
		);

		return () => {
			ctx.disposed = true;
			if (vrmRef.current) {
				scene.remove(vrmRef.current.scene);
				VRMUtils.deepDispose(vrmRef.current.scene);
				vrmRef.current = null;
			}
		};
	}, [url, scene]);

	return vrm;
}

// ─── Expression Sync Hook ───────────────────────────────────────

function useExpressionSync(vrm: VRM | null, expressionWeight: VrmExpressionWeight | null) {
	useEffect(() => {
		if (!vrm?.expressionManager) return;
		syncVrmExpression(vrm.expressionManager, expressionWeight);
	}, [vrm, expressionWeight]);
}

// ─── VRM Animation Hook ────────────────────────────────────────

function firstVrmAnimation(gltf: { userData: Record<string, unknown> }): VRMAnimation | null {
	const animations = gltf.userData["vrmAnimations"];
	if (!Array.isArray(animations) || animations.length === 0) return null;
	return animations[0] as VRMAnimation;
}

function useVrmAnimation(
	vrm: VRM | null,
	animationUrl: string,
	onError: (message: string) => void,
) {
	const [animationMixer, setAnimationMixer] = useState<THREE.AnimationMixer | null>(null);
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;

	useEffect(() => {
		setAnimationMixer(null);
		if (!vrm) return;

		const loader = new GLTFLoader();
		loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

		let disposed = false;
		let mixer: THREE.AnimationMixer | null = null;
		let action: THREE.AnimationAction | null = null;

		loader.load(
			animationUrl,
			(gltf) => {
				if (disposed) return;
				const animation = firstVrmAnimation(gltf);
				if (!animation) {
					onErrorRef.current("VRMA データが見つかりません");
					return;
				}

				const clip = createVRMAnimationClip(animation, vrm);
				mixer = new THREE.AnimationMixer(vrm.scene);
				action = mixer.clipAction(clip);
				action.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY);
				action.reset().play();
				setAnimationMixer(mixer);
			},
			undefined,
			() => {
				if (!disposed) onErrorRef.current("モーションの読み込みに失敗しました");
			},
		);

		return () => {
			disposed = true;
			action?.stop();
			mixer?.stopAllAction();
			mixer?.uncacheRoot(vrm.scene);
		};
	}, [animationUrl, vrm]);

	return animationMixer;
}

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
