import type ShikiPlugin from 'packages/obsidian/src/main';
import { SHIKI_INLINE_REGEX } from 'packages/obsidian/src/main';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type EditorState, type Range, StateEffect } from '@codemirror/state';
import { type SyntaxNode } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
import { Cm6_Util } from 'packages/obsidian/src/codemirror/Cm6_Util';
import { buildHighlightRegionUpdates, type HighlightRegion, LatestTaskScheduler, mapHighlightRegions } from 'packages/obsidian/src/codemirror/Cm6_UpdatePlan';
import { type ThemedToken } from 'shiki';
import { editorLivePreviewField } from 'obsidian';

const DOCUMENT_UPDATE_DELAY_MS = 100;

interface AppliedHighlightState {
	decorations: DecorationSet;
	regions: HighlightRegion[];
	forced: boolean;
}

interface PreparedHighlightState extends AppliedHighlightState {
	hasChanges: boolean;
}

const applyHighlightState = StateEffect.define<AppliedHighlightState>();

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- not an easily named type
export function createCm6Plugin(plugin: ShikiPlugin) {
	return ViewPlugin.fromClass(
		class Cm6ViewPlugin {
			decorations: DecorationSet;
			regions: HighlightRegion[];
			view: EditorView;

			private readonly scheduler: LatestTaskScheduler<PreparedHighlightState>;
			private forceNextUpdate = false;
			private destroyed = false;

			constructor(view: EditorView) {
				this.view = view;
				this.decorations = Decoration.none;
				this.regions = [];
				this.scheduler = new LatestTaskScheduler(
					() => this.prepareHighlightState(),
					prepared => this.applyPreparedHighlightState(prepared),
				);

				this.scheduleUpdate(0);

				plugin.updateCm6Plugin = (): Promise<void> => {
					this.forceNextUpdate = true;
					return this.scheduler.request(0);
				};
			}

			/**
			 * Maps existing decorations synchronously and schedules only the asynchronous
			 * work that may have changed.
			 *
			 * @param update
			 */
			update(update: ViewUpdate): void {
				this.view = update.view;

				if (update.docChanged) {
					try {
						this.decorations = this.decorations.map(update.changes);
						this.regions = mapHighlightRegions(this.regions, update.changes);
					} catch (error) {
						this.decorations = Decoration.none;
						this.regions = [];
						console.warn('Resetting decorations due to error:', error);
					}
				}

				let appliedScheduledState = false;
				for (const transaction of update.transactions) {
					for (const effect of transaction.effects) {
						if (effect.is(applyHighlightState)) {
							this.decorations = effect.value.decorations;
							this.regions = effect.value.regions;
							if (effect.value.forced) {
								this.forceNextUpdate = false;
							}
							appliedScheduledState = true;
						}
					}
				}

				if (appliedScheduledState) {
					return;
				}
				if (update.docChanged) {
					this.scheduleUpdate(DOCUMENT_UPDATE_DELAY_MS);
				} else if (update.selectionSet) {
					this.scheduleUpdate(0);
				}
			}

			isLivePreview(state: EditorState): boolean {
				// @ts-ignore some strange private field not being assignable
				return state.field(editorLivePreviewField);
			}

			private scheduleUpdate(delayMs: number): void {
				void this.scheduler.request(delayMs).catch(error => {
					if (!this.destroyed) {
						console.error('Failed to update Shiki editor decorations:', error);
					}
				});
			}

			private async prepareHighlightState(): Promise<PreparedHighlightState> {
				const state = this.view.state;
				const currentRegions = this.collectHighlightRegions(state);
				const forced = this.forceNextUpdate;
				const update = await buildHighlightRegionUpdates(
					this.regions,
					currentRegions,
					async region => {
						try {
							return await this.buildDecorations(region);
						} catch (error) {
							console.error(error);
							return [];
						}
					},
					forced,
				);

				return {
					decorations: this.applyDecorationChanges(update.remove, update.add),
					regions: update.regions,
					forced,
					hasChanges: update.hasChanges,
				};
			}

			private applyPreparedHighlightState(prepared: PreparedHighlightState): void {
				if (!prepared.hasChanges) {
					return;
				}

				this.view.dispatch({
					effects: applyHighlightState.of({
						decorations: prepared.decorations,
						regions: prepared.regions,
						forced: prepared.forced,
					}),
				});
			}

			private collectHighlightRegions(state: EditorState): HighlightRegion[] {
				let language = '';
				let codeBlockLines: SyntaxNode[] = [];
				const regions: HighlightRegion[] = [];

				syntaxTree(state).iterate({
					enter: nodeRef => {
						const node = nodeRef.node;
						const props = new Set(node.type.name?.split('_'));

						if (props.has('formatting')) {
							return;
						}

						if (props.has('inline-code')) {
							const content = Cm6_Util.getContent(state, node.from, node.to);
							if (!content.startsWith('{') || !plugin.settings.inlineHighlighting) {
								return;
							}

							const match = content.match(SHIKI_INLINE_REGEX);
							if (!match) {
								return;
							}

							const hideTo = node.from + match[1].length + 3;
							const hasSelectionOverlap = Cm6_Util.checkSelectionAndRangeOverlap(state.selection, node.from - 1, node.to + 1);
							regions.push({
								kind: 'inline',
								from: node.from,
								to: node.to,
								highlightFrom: hideTo,
								language: match[1],
								content: match[2],
								hideLanguage: this.isLivePreview(state) && !hasSelectionOverlap,
								hideTo,
							});
							return;
						}

						if (props.has('HyperMD-codeblock') && !props.has('HyperMD-codeblock-begin') && !props.has('HyperMD-codeblock-end')) {
							codeBlockLines.push(node);
							return;
						}

						if (props.has('HyperMD-codeblock-begin')) {
							const content = Cm6_Util.getContent(state, node.from, node.to);
							language = /```\s*(\S+)/.exec(content)?.[1] ?? '';
						}

						if (props.has('HyperMD-codeblock-end')) {
							if (codeBlockLines.length > 0 && language !== '') {
								const from = codeBlockLines[0].from;
								const to = codeBlockLines[codeBlockLines.length - 1].to;
								regions.push({
									kind: 'block',
									from,
									to,
									highlightFrom: from,
									language,
									content: Cm6_Util.getContent(state, from, to),
								});
							}

							language = '';
							codeBlockLines = [];
						}
					},
				});

				return regions;
			}

			private applyDecorationChanges(remove: readonly { from: number; to: number }[], add: readonly Range<Decoration>[]): DecorationSet {
				if (remove.length === 0) {
					return add.length === 0 ? this.decorations : this.decorations.update({ add, sort: true });
				}

				const removalRanges = this.mergeRanges(remove);
				return this.decorations.update({
					filterFrom: removalRanges[0].from,
					filterTo: removalRanges[removalRanges.length - 1].to,
					filter: (from, to) => !this.overlapsAnyRange(from, to, removalRanges),
					add,
					sort: true,
				});
			}

			private mergeRanges(ranges: readonly { from: number; to: number }[]): { from: number; to: number }[] {
				const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
				const merged: { from: number; to: number }[] = [];

				for (const range of sorted) {
					const last = merged.at(-1);
					if (last && range.from <= last.to) {
						last.to = Math.max(last.to, range.to);
					} else {
						merged.push({ ...range });
					}
				}

				return merged;
			}

			private overlapsAnyRange(from: number, to: number, ranges: readonly { from: number; to: number }[]): boolean {
				let low = 0;
				let high = ranges.length - 1;

				while (low <= high) {
					const middle = Math.floor((low + high) / 2);
					const range = ranges[middle];
					if (range.to < from) {
						low = middle + 1;
					} else if (range.from > to) {
						high = middle - 1;
					} else {
						return true;
					}
				}

				return false;
			}

			private async buildDecorations(region: HighlightRegion): Promise<Range<Decoration>[]> {
				if (region.language === '') {
					return [];
				}

				const highlight = await plugin.highlighter.getHighlightTokens(region.content, region.language.toLowerCase());
				if (!highlight) {
					return [];
				}

				const tokens = highlight.tokens.flat(1);
				const decorations: Range<Decoration>[] = [];

				if (region.hideLanguage && region.hideTo !== undefined) {
					decorations.push(Decoration.replace({}).range(region.from, region.hideTo));
				}

				for (let i = 0; i < tokens.length; i++) {
					const token = tokens[i];
					const nextToken: ThemedToken | undefined = tokens[i + 1];
					const tokenStyle = plugin.highlighter.getTokenStyle(token);

					decorations.push(
						Decoration.mark({
							attributes: {
								style: tokenStyle.style,
								class: tokenStyle.classes.join(' '),
							},
						}).range(region.highlightFrom + token.offset, nextToken ? region.highlightFrom + nextToken.offset : region.to),
					);
				}

				return decorations;
			}

			/**
			 * Triggered when the CodeMirror view plugin is destroyed.
			 */
			destroy(): void {
				this.destroyed = true;
				this.scheduler.destroy();
				this.decorations = Decoration.none;
				this.regions = [];
			}
		},
		{
			decorations: value => value.decorations,
		},
	);
}
