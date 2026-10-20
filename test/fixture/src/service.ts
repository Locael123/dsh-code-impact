import { RetryPolicy, buildPolicy } from './policy';
import { parseTimeout } from '@/config';

export function makeService(): RetryPolicy {
	const policy = buildPolicy({ timeout: parseTimeout });
	return policy;
}
