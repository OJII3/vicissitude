import { useRef } from "react";

/** 最新の値を常に .current に保持する ref（callback を effect 依存に入れずに最新版を参照する用） */
export function useLatestRef<T>(value: T) {
	const ref = useRef(value);
	ref.current = value;
	return ref;
}
