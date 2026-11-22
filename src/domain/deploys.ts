import {
	type Deploy,
	MAX_DEPLOY_WINDOW_MINUTES,
	type Scenario,
	type Service,
} from "./schemas.js";

export const DEFAULT_DEPLOY_WINDOW_MINUTES = 60;

export interface DeployQuery {
	readonly service?: Service | undefined;
	/** Inclusive. Defaults to 60. */
	readonly withinMinutes?: number | undefined;
}

/**
 * Deploys from the last `withinMinutes` before the scenario clock, newest
 * first. Callers validate the window; out of range is a RangeError.
 */
export function listRecentDeploys(
	scenario: Scenario,
	{ service, withinMinutes = DEFAULT_DEPLOY_WINDOW_MINUTES }: DeployQuery = {},
): Deploy[] {
	if (
		!Number.isInteger(withinMinutes) ||
		withinMinutes < 1 ||
		withinMinutes > MAX_DEPLOY_WINDOW_MINUTES
	) {
		throw new RangeError(
			`withinMinutes must be an integer from 1 to ${MAX_DEPLOY_WINDOW_MINUTES}, got ${withinMinutes}`,
		);
	}
	// The resolver already sorted these newest first; filter keeps that order.
	return scenario.deploys.filter(
		(deploy) =>
			deploy.minutes_before_start <= withinMinutes &&
			(service === undefined || deploy.service_id === service.id),
	);
}
