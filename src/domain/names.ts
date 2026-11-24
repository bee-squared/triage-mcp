/**
 * How exact lookups compare IDs and names: case-insensitive, treating spaces,
 * hyphens and underscores alike, so `Payment Gateway` finds `payment-gateway`.
 */
export const normalize = (text: string): string =>
	text
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "-");
