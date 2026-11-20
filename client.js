window.__ModuleLoader__.load({
	id: 'dsh-session-agent-mode',
	factory(require) {
		const React = require('react');

		const NS = 'sessionAgentMode';

		/** Presets the installation ships; their short labels live in this plugin's dictionaries. */
		const BUILT_IN_IDS = new Set(['standard', 'ptc', 'minimal', 'cordis']);

		/**
		 * Short mode labels. Every non-ASCII character is written as a \u escape so the
		 * bundle stays plain ASCII and no encoding step can corrupt it.
		 */
		const DICTIONARIES = {
			en: {
				'preset.standard': 'Standard',
				'preset.ptc': 'PTC',
				'preset.minimal': 'Minimal',
				'preset.cordis': 'Creator',
				'hint': 'Agent preset this task runs',
			},
			ru: {
				'preset.standard': '\u0421\u0442\u0430\u043d\u0434\u0430\u0440\u0442',
				'preset.ptc': 'PTC',
				'preset.minimal': '\u041c\u0438\u043d\u0438\u043c\u0443\u043c',
				'preset.cordis': '\u0410\u0432\u0442\u043e\u0440',
				'hint': '\u0420\u0435\u0436\u0438\u043c, \u0432 \u043a\u043e\u0442\u043e\u0440\u043e\u043c \u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442 \u044d\u0442\u0430 \u0441\u0435\u0441\u0441\u0438\u044f',
			},
			zh: {
				'preset.standard': '\u6807\u51c6',
				'preset.ptc': 'PTC',
				'preset.minimal': '\u6781\u7b80',
				'preset.cordis': '\u521b\u5efa',
				'hint': '\u6b64\u4f1a\u8bdd\u8fd0\u884c\u7684\u667a\u80fd\u4f53\u6a21\u5f0f',
			},
		};

		/** Compact chip: 10px type like the row's time label, never wider than a few characters. */
		const chipStyle = {
			display: 'inline-flex',
			alignItems: 'center',
			flex: 'none',
			maxWidth: 84,
			padding: '0 4px',
			borderRadius: 4,
			border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
			color: 'var(--dsw-alias-label-tertiary, currentColor)',
			fontSize: 10,
			lineHeight: '14px',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
		};

		/**
		 * Preset id -> display name and description from the Host roster, published as
		 * one reference-stable snapshot so the chip re-renders only on a real change.
		 * @returns the store behind the `useAgentPresetRoster` seat.
		 */
		function createRosterStore() {
			let snapshot = { names: new Map(), descriptions: new Map() };
			const listeners = new Set();
			return {
				source: {
					getSnapshot: () => snapshot,
					subscribe(listener) {
						listeners.add(listener);
						return () => {
							listeners.delete(listener);
						};
					},
				},
				publish(presets) {
					const names = new Map();
					const descriptions = new Map();
					for (const preset of presets) {
						if (preset === null || typeof preset !== 'object') continue;
						if (typeof preset.id !== 'string' || preset.id === '') continue;
						if (typeof preset.name === 'string' && preset.name !== '') names.set(preset.id, preset.name);
						if (typeof preset.description === 'string' && preset.description !== '') {
							descriptions.set(preset.id, preset.description);
						}
					}
					snapshot = { names, descriptions };
					for (const listener of [...listeners]) {
						try {
							listener();
						} catch (_error) {
							// One broken subscriber must not stop the others.
						}
					}
				},
				knows: (presetId) => snapshot.names.has(presetId) || BUILT_IN_IDS.has(presetId),
			};
		}

		/**
		 * The everyday preset: a Session running it gets no chip, so the ordinary
		 * case stays as quiet as it was before this plugin existed.
		 */
		const QUIET_PRESET = 'standard';

		/**
		 * One Session's mode chip.
		 * @param props.sessionId - the row's Session.
		 * @param props.useSessions - root Session catalog hook supplied by the row.
		 * @param props.useAgentPresetRoster - this plugin's roster hook.
		 * @param props.t - this namespace's locale seat.
		 * @returns the chip, or nothing for the standard preset and for a Session that lists none.
		 */
		function SessionAgentModeChip({ sessionId, useSessions, useAgentPresetRoster, t }) {
			const presetId = useSessions((state) => {
				const value = state.byId[sessionId]?.projectionValues?.agentPreset;
				return typeof value === 'string' && value !== '' ? value : undefined;
			});
			const roster = useAgentPresetRoster((state) => state);
			if (presetId === undefined || presetId === QUIET_PRESET) return null;

			const label = roster.names.get(presetId) ?? t(`preset.${presetId}`);
			const asked = roster.descriptions.get(presetId);
			const title = asked === undefined ? `${t('hint')}: ${label}` : `${label} - ${asked}`;

			return React.createElement(
				'span',
				{
					style: chipStyle,
					title,
					'data-session-agent-mode': presetId,
				},
				label,
			);
		}

		return {
			inject: ['slots', 'locale', 'sessions', 'remote', 'remote.agentPresets'],
			apply(ctx) {
				const sessions = ctx.get('sessions');
				const roster = createRosterStore();
				let rosterState = 'idle';
				/**
				 * Ids a read was already asked for. A roster the Host answered without
				 * naming the id leaves it unknown, and without this the next list change
				 * would ask again - one request per list update, forever.
				 */
				const asked = new Set();
				/** Ids the in-flight read was asked for, dropped again if it fails. */
				let pending = new Set();

				/** Read the Host roster; a preset id never seen before asks again. */
				const loadRoster = () => {
					if (rosterState === 'loading') return;
					rosterState = 'loading';
					let request;
					try {
						request = ctx.remote.agentPresets.list();
					} catch (_error) {
						rosterState = 'idle';
						pending = new Set();
						return;
					}
					Promise.resolve(request)
						.then((result) => {
							if (result === null || typeof result !== 'object' || result.ok !== true) {
								rosterState = 'idle';
								for (const presetId of pending) asked.delete(presetId);
								pending = new Set();
								return;
							}
							const presets = result.value?.presets;
							if (!Array.isArray(presets)) {
								rosterState = 'idle';
								for (const presetId of pending) asked.delete(presetId);
								pending = new Set();
								return;
							}
							rosterState = 'ready';
							pending = new Set();
							roster.publish(presets);
						})
						.catch(() => {
							rosterState = 'idle';
							for (const presetId of pending) asked.delete(presetId);
							pending = new Set();
						});
				};

				/** Ask for the roster once per preset id this plugin has not asked about yet. */
				const ensureKnown = () => {
					if (rosterState !== 'idle' && rosterState !== 'ready') return;
					const list = sessions.list.getSnapshot();
					for (const row of Object.values(list.byId)) {
						const presetId = row?.projectionValues?.agentPreset;
						if (typeof presetId !== 'string' || roster.knows(presetId) || asked.has(presetId)) continue;
						asked.add(presetId);
						pending.add(presetId);
						loadRoster();
						return;
					}
				};

				ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'session-agent-mode: dictionaries');

				ctx.effect(
					() => {
						loadRoster();
						const dispose = sessions.list.subscribe(() => {
							ensureKnown();
						});
						return dispose;
					},
					'session-agent-mode: roster load',
				);

				ctx.slots.inject('sidebar.session.row.trailing', () =>
					ctx.slots.register(
						{
							name: 'sidebar.session.row.trailing',
							id: 'agent-mode',
							order: 20,
							locale: NS,
							inject: () => ({ hooks: { agentPresetRoster: roster.source } }),
						},
						SessionAgentModeChip,
					),
				);

			},
		};
	},
});
