export type ResponseAction =
	| { type: "respond" }
	| { type: "react"; emoji: string }
	| { type: "ignore" };

export interface ResponseDecision {
	action: ResponseAction;
	reason: string;
}
