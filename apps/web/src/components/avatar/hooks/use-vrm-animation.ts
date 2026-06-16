import type { VRM } from "@pixiv/three-vrm";
import {
	createVRMAnimationClip,
	VRMAnimationLoaderPlugin,
	type VRMAnimation,
} from "@pixiv/three-vrm-animation";
import { useEffect, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { useLatestRef } from "./use-latest-ref";

function firstVrmAnimation(gltf: { userData: Record<string, unknown> }): VRMAnimation | null {
	const animations = gltf.userData["vrmAnimations"];
	if (!Array.isArray(animations) || animations.length === 0) return null;
	return animations[0] as VRMAnimation;
}

export function useVrmAnimation(
	vrm: VRM | null,
	animationUrl: string,
	onError: (message: string) => void,
) {
	const [animationMixer, setAnimationMixer] = useState<THREE.AnimationMixer | null>(null);
	const onErrorRef = useLatestRef(onError);

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
		// onErrorRef は useLatestRef が返す安定 ref のため依存に含めない（最新版を .current で参照）
		// oxlint-disable-next-line exhaustive-deps
	}, [animationUrl, vrm]);

	return animationMixer;
}
