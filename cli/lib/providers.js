import { PROVIDERS, PROVIDER_IDS } from '../../src/config.js';

export const PROVIDER_LABELS = PROVIDER_IDS.map((id) => PROVIDERS[id].label);
/** @param {string} name */
export const providerId = (name) => PROVIDER_IDS.find((id) => id === name || PROVIDERS[id].label === name);
/** @param {string} id */
export const providerLabel = (id) => PROVIDERS[id]?.label ?? id;
