import type { VRM } from "@pixiv/three-vrm";
import { useEffect, useRef } from "react";

const BLINK_INTERVAL_MIN = 2000;
const BLINK_INTERVAL_MAX = 6000;
const BLINK_DURATION = 120;

export function useAutoBlink(vrm: VRM | null) {
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
