import type { VRM } from "@pixiv/three-vrm";
import type { VrmExpressionWeight } from "@vicissitude/shared/emotion";
import { useEffect } from "react";

import { syncVrmExpression } from "../expression-sync";

export function useExpressionSync(vrm: VRM | null, expressionWeight: VrmExpressionWeight | null) {
	useEffect(() => {
		if (!vrm?.expressionManager) return;
		syncVrmExpression(vrm.expressionManager, expressionWeight);
	}, [vrm, expressionWeight]);
}
