import type {Env} from './types.ts';
import {createGoogleRelayFetch} from './google-relay.ts';

/**
 * Select the platform upstream fetcher.
 * Default behavior is deliberately unchanged: native Cloudflare fetch.
 * Google relay is opt-in only when GOOGLE_RELAY_ENABLED === "true".
 */
export function upstreamFetch(env:Env):typeof fetch{
 if(env.GOOGLE_RELAY_ENABLED!=='true')return fetch;
 return createGoogleRelayFetch(env);
}
