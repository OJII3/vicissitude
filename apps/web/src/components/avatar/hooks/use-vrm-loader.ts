import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { VRM } from "@pixiv/three-vrm";
import { useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { useLatestRef } from "./use-latest-ref";

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

export function useVrmLoader(
	url: string,
	onError: (message: string) => void,
	onLoaded: () => void,
) {
	const [vrm, setVrm] = useState<VRM | null>(null);
	const vrmRef = useRef<VRM | null>(null);
	const { scene } = useThree();
	const onErrorRef = useLatestRef(onError);
	const onLoadedRef = useLatestRef(onLoaded);

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
		// onErrorRef / onLoadedRef は useLatestRef が返す安定 ref のため依存に含めない（最新版を .current で参照）
		// oxlint-disable-next-line exhaustive-deps
	}, [url, scene]);

	return vrm;
}
