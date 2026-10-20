export const parseTimeout = 30;

export interface Options {
	timeout: number;
	retries?: number;
}

export class Base {
	run(input: string): number {
		return input.length;
	}

	protected helper(): void {
		return undefined;
	}
}

export default class DefaultThing {
	kind = 'default';
}
