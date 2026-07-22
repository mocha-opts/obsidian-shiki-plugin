import type { ChangeDesc } from '@codemirror/state';

export interface HighlightRegion {
	kind: 'block' | 'inline';
	from: number;
	to: number;
	highlightFrom: number;
	language: string;
	content: string;
	hideLanguage?: boolean;
	hideTo?: number;
}

export interface HighlightRegionUpdatePlan {
	regions: HighlightRegion[];
	build: HighlightRegion[];
	remove: { from: number; to: number }[];
	hasChanges: boolean;
}

function regionKey(region: HighlightRegion): string {
	return `${region.kind}:${region.from}:${region.to}`;
}

function regionsEqual(left: HighlightRegion, right: HighlightRegion): boolean {
	return (
		left.kind === right.kind &&
		left.from === right.from &&
		left.to === right.to &&
		left.highlightFrom === right.highlightFrom &&
		left.language === right.language &&
		left.content === right.content &&
		left.hideLanguage === right.hideLanguage &&
		left.hideTo === right.hideTo
	);
}

export function mapHighlightRegions(regions: readonly HighlightRegion[], changes: ChangeDesc): HighlightRegion[] {
	return regions.map(region => ({
		...region,
		from: changes.mapPos(region.from, -1),
		to: changes.mapPos(region.to, 1),
		highlightFrom: changes.mapPos(region.highlightFrom, -1),
		hideTo: region.hideTo === undefined ? undefined : changes.mapPos(region.hideTo, 1),
	}));
}

export function planHighlightRegionUpdates(
	previous: readonly HighlightRegion[],
	current: readonly HighlightRegion[],
	force: boolean = false,
): HighlightRegionUpdatePlan {
	if (force) {
		return {
			regions: [...current],
			build: [...current],
			remove: previous.map(({ from, to }) => ({ from, to })),
			hasChanges: true,
		};
	}

	const previousByKey = new Map(previous.map(region => [regionKey(region), region]));
	const build: HighlightRegion[] = [];
	const remove: { from: number; to: number }[] = [];

	for (const region of current) {
		const key = regionKey(region);
		const cached = previousByKey.get(key);
		if (!cached) {
			build.push(region);
			continue;
		}

		previousByKey.delete(key);
		if (!regionsEqual(cached, region)) {
			build.push(region);
			remove.push({ from: cached.from, to: cached.to });
		}
	}

	for (const region of previousByKey.values()) {
		remove.push({ from: region.from, to: region.to });
	}

	return { regions: [...current], build, remove, hasChanges: build.length > 0 || remove.length > 0 };
}

export async function buildHighlightRegionUpdates<T>(
	previous: readonly HighlightRegion[],
	current: readonly HighlightRegion[],
	build: (region: HighlightRegion) => Promise<readonly T[]>,
	force: boolean = false,
): Promise<HighlightRegionUpdatePlan & { add: T[] }> {
	const plan = planHighlightRegionUpdates(previous, current, force);
	const add: T[] = [];

	for (const region of plan.build) {
		add.push(...(await build(region)));
	}

	return { ...plan, add };
}

export class LatestTaskScheduler<T> {
	private revision = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private runAfterCurrent = false;
	private destroyed = false;
	private readonly waiters: {
		revision: number;
		resolve: () => void;
		reject: (error: unknown) => void;
	}[] = [];

	constructor(
		private readonly work: (revision: number) => Promise<T>,
		private readonly apply: (result: T, revision: number) => void,
	) {}

	request(delayMs: number): Promise<void> {
		if (this.destroyed) {
			return Promise.reject(new Error('LatestTaskScheduler has been destroyed'));
		}

		const revision = ++this.revision;
		const done = new Promise<void>((resolve, reject) => {
			this.waiters.push({ revision, resolve, reject });
		});

		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		this.runAfterCurrent = false;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.start();
			},
			Math.max(0, delayMs),
		);

		return done;
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}

		this.destroyed = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.rejectWaiters(new Error('LatestTaskScheduler has been destroyed'));
	}

	private async start(): Promise<void> {
		if (this.destroyed) {
			return;
		}
		if (this.running) {
			this.runAfterCurrent = true;
			return;
		}

		this.running = true;
		const revision = this.revision;
		try {
			const result = await this.work(revision);
			if (!this.destroyed && revision === this.revision) {
				this.apply(result, revision);
				this.resolveWaiters(revision);
			}
		} catch (error) {
			if (!this.destroyed && revision === this.revision) {
				this.rejectWaiters(error, revision);
			}
		} finally {
			this.running = false;
			if (!this.destroyed && this.runAfterCurrent) {
				this.runAfterCurrent = false;
				void this.start();
			}
		}
	}

	private resolveWaiters(revision: number): void {
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			if (this.waiters[i].revision <= revision) {
				this.waiters[i].resolve();
				this.waiters.splice(i, 1);
			}
		}
	}

	private rejectWaiters(error: unknown, revision: number = Number.POSITIVE_INFINITY): void {
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			if (this.waiters[i].revision <= revision) {
				this.waiters[i].reject(error);
				this.waiters.splice(i, 1);
			}
		}
	}
}
