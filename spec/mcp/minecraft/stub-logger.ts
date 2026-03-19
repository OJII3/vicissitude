import type { Logger } from "@vicissitude/shared/types";

export const stubLogger: Logger = { info() {}, warn() {}, error() {} };
