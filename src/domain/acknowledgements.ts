import type { Service, Severity } from "./schemas.js";

// In-memory acknowledgements (PRD FR-16): they last as long as the store and
// are never persisted. The server factory injects a store, so each eval trial
// gets a fresh one and the HTTP transport shares one per process.

export const MAX_ACK_SUMMARY_LENGTH = 200;

/** Oldest acknowledgements are dropped past this, so a long-lived process can't grow without bound. */
export const MAX_STORED_ACKS = 1000;

/** PRD Acknowledgement. */
export interface Acknowledgement {
	/** `ACK-0001`, counting up from 1 per store. */
	readonly confirmation_id: string;
	readonly service_id: string;
	readonly severity: Severity;
	readonly summary: string;
	/** ISO 8601, from the store's clock. */
	readonly created_at: string;
}

export interface AcknowledgementInput {
	/** Callers resolve it first, so an unknown service can't be acknowledged. */
	readonly service: Service;
	readonly severity: Severity;
	readonly summary: string;
}

export interface AcknowledgementStore {
	/** Records a new acknowledgement every call: repeating one is not idempotent. */
	acknowledge(input: AcknowledgementInput): Acknowledgement;
	/** Oldest first. */
	list(): readonly Acknowledgement[];
}

export interface AcknowledgementStoreOptions {
	/** Defaults to the system clock. Tests pass a fixed one. */
	readonly now?: (() => Date) | undefined;
}

/**
 * Callers validate the summary; one that is blank or over 200 characters
 * after trimming is a RangeError.
 */
export function createAcknowledgementStore({
	now = () => new Date(),
}: AcknowledgementStoreOptions = {}): AcknowledgementStore {
	const acks: Acknowledgement[] = [];
	let count = 0;
	return {
		acknowledge({ service, severity, summary }) {
			const text = summary.trim();
			if (text.length === 0 || text.length > MAX_ACK_SUMMARY_LENGTH) {
				throw new RangeError(
					`summary must be 1 to ${MAX_ACK_SUMMARY_LENGTH} characters, got ${text.length}`,
				);
			}
			count += 1;
			const ack: Acknowledgement = Object.freeze({
				confirmation_id: `ACK-${String(count).padStart(4, "0")}`,
				service_id: service.id,
				severity,
				summary: text,
				created_at: now().toISOString(),
			});
			acks.push(ack);
			if (acks.length > MAX_STORED_ACKS) acks.shift();
			return ack;
		},
		list: () => [...acks],
	};
}
