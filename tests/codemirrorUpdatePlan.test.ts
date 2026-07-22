import { describe, expect, test } from 'bun:test';
import { ChangeSet } from '@codemirror/state';
import {
	buildHighlightRegionUpdates,
	LatestTaskScheduler,
	mapHighlightRegions,
	planHighlightRegionUpdates,
	type HighlightRegion,
} from 'packages/obsidian/src/codemirror/Cm6_UpdatePlan';

function block(index: number, content: string = `const value${index} = ${index};`): HighlightRegion {
	const from = index * 100 + 10;
	return {
		kind: 'block',
		from,
		to: from + content.length,
		highlightFrom: from,
		language: 'ts',
		content,
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('highlight region update planning', () => {
	test('reuses 100 unchanged blocks after an edit before them', () => {
		const previous = Array.from({ length: 100 }, (_, index) => block(index));
		const changes = ChangeSet.of([{ from: 0, insert: 'prefix' }], 10_000);
		const mapped = mapHighlightRegions(previous, changes);
		const current = mapped.map(region => ({ ...region }));

		const plan = planHighlightRegionUpdates(mapped, current);

		expect(plan.build).toHaveLength(0);
		expect(plan.remove).toHaveLength(0);
		expect(plan.regions).toEqual(current);
		expect(plan.hasChanges).toBe(false);
	});

	test('rebuilds only the block whose content changed', () => {
		const previous = Array.from({ length: 100 }, (_, index) => block(index));
		const current = previous.map(region => ({ ...region }));
		current[42] = { ...current[42], content: 'const changed = true;' };

		const plan = planHighlightRegionUpdates(previous, current);

		expect(plan.build).toEqual([current[42]]);
		expect(plan.remove).toEqual([{ from: previous[42].from, to: previous[42].to }]);
		expect(plan.hasChanges).toBe(true);
	});

	test('rebuilds changed languages and removes deleted regions', () => {
		const first = block(0);
		const second = block(1);
		const changed = { ...first, language: 'javascript' };

		const plan = planHighlightRegionUpdates([first, second], [changed]);

		expect(plan.build).toEqual([changed]);
		expect(plan.remove).toEqual([
			{ from: first.from, to: first.to },
			{ from: second.from, to: second.to },
		]);
	});

	test('rebuilds inline code when its hidden language marker changes', () => {
		const previous: HighlightRegion = {
			kind: 'inline',
			from: 10,
			to: 30,
			highlightFrom: 18,
			language: 'js',
			content: 'const x = 1',
			hideLanguage: true,
			hideTo: 18,
		};
		const current = { ...previous, hideLanguage: false };

		const plan = planHighlightRegionUpdates([previous], [current]);

		expect(plan.build).toEqual([current]);
		expect(plan.remove).toEqual([{ from: 10, to: 30 }]);
	});

	test('forces every region to rebuild after highlighter reload', () => {
		const regions = [block(0), block(1), block(2)];

		const plan = planHighlightRegionUpdates(regions, regions, true);

		expect(plan.build).toEqual(regions);
		expect(plan.remove).toEqual(regions.map(({ from, to }) => ({ from, to })));
		expect(plan.hasChanges).toBe(true);
	});

	test('calls the decoration builder only for changed regions', async () => {
		const previous = Array.from({ length: 100 }, (_, index) => block(index));
		const current = previous.map(region => ({ ...region }));
		current[42] = { ...current[42], content: 'const changed = true;' };
		const built: HighlightRegion[] = [];

		const update = await buildHighlightRegionUpdates(previous, current, async region => {
			built.push(region);
			return [`decorations:${region.from}`];
		});

		expect(built).toEqual([current[42]]);
		expect(update.add).toEqual([`decorations:${current[42].from}`]);
		expect(update.remove).toEqual([{ from: previous[42].from, to: previous[42].to }]);
	});
});

describe('LatestTaskScheduler', () => {
	test('coalesces rapid requests into the latest task', async () => {
		const runs: number[] = [];
		const applied: number[] = [];
		const scheduler = new LatestTaskScheduler(
			async revision => {
				runs.push(revision);
				return revision;
			},
			result => applied.push(result),
		);

		void scheduler.request(20);
		void scheduler.request(20);
		const done = scheduler.request(20);
		await done;

		expect(runs).toEqual([3]);
		expect(applied).toEqual([3]);
		scheduler.destroy();
	});

	test('does not apply an in-flight result after a newer request', async () => {
		const first = deferred<number>();
		const second = deferred<number>();
		const applied: number[] = [];
		const scheduler = new LatestTaskScheduler(
			revision => (revision === 1 ? first.promise : second.promise),
			result => applied.push(result),
		);

		void scheduler.request(0);
		await Bun.sleep(5);
		const latestDone = scheduler.request(0);
		await Bun.sleep(5);
		first.resolve(1);
		await Bun.sleep(5);
		second.resolve(2);
		await latestDone;

		expect(applied).toEqual([2]);
		scheduler.destroy();
	});

	test('cancels delayed work when destroyed', async () => {
		let runs = 0;
		const scheduler = new LatestTaskScheduler(
			async () => ++runs,
			() => {},
		);

		const pending = scheduler.request(20);
		scheduler.destroy();

		await expect(pending).rejects.toThrow('destroyed');
		await Bun.sleep(25);
		expect(runs).toBe(0);
	});
});
