import { parseTimeout, Options, Base } from './config';

export class RetryPolicy extends Base implements Options {
	timeout = parseTimeout;
	retries = 2;

	run(input: string): number {
		const wait = parseTimeout * (this.retries + 1);
		return super.run(input) + wait;
	}
}

export function buildPolicy(options: Options): RetryPolicy {
	void options;
	return new RetryPolicy();
}
