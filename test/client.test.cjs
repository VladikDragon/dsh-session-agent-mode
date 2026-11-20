/**
 * Headless harness for dsh-session-agent-mode: loads the browser bundle with a fake
 * module loader, mocks the Client services it injects, and drives the release's
 * scenarios.
 *
 * Run: node test/client.test.cjs client.js
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const CLIENT = process.argv[2] ?? 'client.js';
const SLOT = 'sidebar.session.row.trailing';
const NS = 'sessionAgentMode';

// ------------------------------------------------------------------ fake react

const React = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children };
	},
};

// ------------------------------------------------------------------ harness

/** Loads client.js through a fake `window.__ModuleLoader__` and returns its definition. */
function loadBundle() {
	const source = fs.readFileSync(path.resolve(CLIENT), 'utf8');
	let definition;
	const window = {
		__ModuleLoader__: {
			load(candidate) {
				definition = candidate;
			},
		},
	};
	// eslint-disable-next-line no-new-func
	new Function('window', source)(window);
	assert.ok(definition, 'client.js did not call window.__ModuleLoader__.load()');
	const require = (id) => {
		assert.strictEqual(id, 'react', `unexpected module request: ${id}`);
		return React;
	};
	return definition.factory(require);
}

/** The dictionaries the bundle registers, keyed by language. */
function readDictionaries() {
	const source = fs.readFileSync(path.resolve(CLIENT), 'utf8');
	const match = source.match(/const DICTIONARIES = (\{[\s\S]*?\n\t\t\});/);
	assert.ok(match, 'DICTIONARIES literal not found in client.js');
	// eslint-disable-next-line no-new-func
	return new Function(`return ${match[1]}`)();
}

/** Minimal stand-in for the `sessions` service the row hands to the chip. */
function createSessions(rows) {
	const state = { byId: { ...rows } };
	const listeners = new Set();
	return {
		state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		listenerCount: () => listeners.size,
		set(rows2) {
			state.byId = { ...rows2 };
			for (const listener of [...listeners]) listener();
		},
		list: {
			getSnapshot: () => state,
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
}

/** Minimal stand-in for `remote.agentPresets`, counting the calls it receives. */
function createRemote(responder) {
	const calls = [];
	return {
		calls,
		agentPresets: {
			list() {
				calls.push(responder.length > 0 ? responder(calls.length) : undefined);
				return responder(calls.length);
			},
		},
	};
}

/** Builds the ctx the bundle's apply() receives. */
function createCtx({ sessions, remote }) {
	const registrations = [];
	const dictionaries = new Map();
	const effects = [];
	const ctx = {
		get: (name) => (name === 'sessions' ? sessions : undefined),
		remote,
		locale: {
			register(namespace, tables) {
				dictionaries.set(namespace, tables);
				return () => dictionaries.delete(namespace);
			},
		},
		effect(fn, label) {
			effects.push({ label, dispose: fn() });
		},
		slots: {
			inject(name, fn) {
				assert.strictEqual(name, SLOT);
				fn();
			},
			register(definition, component) {
				registrations.push({ definition, component });
				return () => {};
			},
		},
	};
	return { ctx, registrations, dictionaries, effects };
}

/** Renders the chip by calling the function component with hook-shaped props. */
function renderChip(component, { sessions, roster, t }) {
	return component({
		sessionId: 's1',
		useSessions: (selector) => selector(sessions.state),
		useAgentPresetRoster: (selector) => selector(roster.current()),
		t,
	});
}

/** Builds a `t` seat for one language from the bundle's own dictionaries. */
function translator(dictionaries, language) {
	const table = dictionaries[language] ?? {};
	return (key) => (key in table ? table[key] : key);
}

/** Reference-stable roster store, mirroring the shape the bundle publishes. */
function createRoster() {
	let snapshot = { names: new Map(), descriptions: new Map() };
	return {
		current: () => snapshot,
		publish(presets) {
			const names = new Map();
			const descriptions = new Map();
			for (const preset of presets) {
				names.set(preset.id, preset.name);
				if (preset.description) descriptions.set(preset.id, preset.description);
			}
			snapshot = { names, descriptions };
		},
	};
}

/** Lets the bundle's promise chain settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Boots the bundle against one set of mocks and returns the working parts. */
async function boot({ rows = {}, responder = () => Promise.resolve(ok([], null)) } = {}) {
	const bundle = loadBundle();
	const sessions = createSessions(rows);
	const remote = createRemote(responder);
	const built = createCtx({ sessions, remote });
	bundle.apply(built.ctx);
	await flush();
	const slot = built.registrations.find((entry) => entry.definition.name === SLOT);
	return { bundle, sessions, remote, slot, registrations: built.registrations, dictionaries: built.dictionaries, effects: built.effects };
}

/** Success envelope of the Host roster call. */
function ok(presets) {
	return { ok: true, value: { presets } };
}

// ------------------------------------------------------------------ scenarios

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the browser half registers one chip in the Session row seat', async () => {
	const { slot } = await boot();
	assert.ok(slot, 'no registration for ' + SLOT);
	assert.strictEqual(slot.definition.id, 'agent-mode');
	assert.strictEqual(slot.definition.order, 20);
	assert.strictEqual(slot.definition.locale, NS);
	assert.strictEqual(typeof slot.component, 'function');
});

test('the bundle is pure ASCII, so no encoding step can corrupt the labels', async () => {
	const source = fs.readFileSync(path.resolve(CLIENT), 'utf8');
	const bad = [...source].filter((character) => character.charCodeAt(0) > 0x7f);
	assert.deepStrictEqual(bad, [], 'non-ASCII characters found in client.js');
});

test('the dictionaries carry every key in en, ru and zh', async () => {
	const dictionaries = readDictionaries();
	assert.deepStrictEqual(Object.keys(dictionaries).sort(), ['en', 'ru', 'zh']);
	for (const [language, table] of Object.entries(dictionaries)) {
		for (const key of ['preset.standard', 'preset.ptc', 'preset.minimal', 'preset.cordis', 'hint']) {
			assert.ok(typeof table[key] === 'string' && table[key] !== '', `${language} misses ${key}`);
		}
	}
	assert.strictEqual(dictionaries.en['preset.cordis'], 'Creator');
	assert.strictEqual(dictionaries.ru['preset.minimal'], 'Минимум');
	assert.strictEqual(dictionaries.zh['preset.standard'], '标准');
});

test('the dictionaries are registered in the plugin namespace', async () => {
	const { dictionaries } = await boot();
	assert.ok(dictionaries.has(NS), 'namespace ' + NS + ' was not registered');
});

test('a Session on the standard preset shows nothing at all', async () => {
	const { slot, dictionaries } = await boot({ rows: { s1: { projectionValues: { agentPreset: 'standard' } } } });
	const tree = renderChip(slot.component, {
		sessions: { state: { byId: { s1: { projectionValues: { agentPreset: 'standard' } } } } },
		roster: createRoster(),
		t: translator(dictionaries.get(NS), 'en'),
	});
	assert.strictEqual(tree, null);
});

test('a Session that lists no preset shows nothing', async () => {
	const { slot, dictionaries } = await boot();
	const empty = renderChip(slot.component, {
		sessions: { state: { byId: { s1: {} } } },
		roster: createRoster(),
		t: translator(dictionaries.get(NS), 'en'),
	});
	assert.strictEqual(empty, null);
	const notString = renderChip(slot.component, {
		sessions: { state: { byId: { s1: { projectionValues: { agentPreset: 42 } } } } },
		roster: createRoster(),
		t: translator(dictionaries.get(NS), 'en'),
	});
	assert.strictEqual(notString, null);
});

test('a built-in mode renders its short label from the plugin dictionaries', async () => {
	const { slot, dictionaries } = await boot();
	const en = translator(dictionaries.get(NS), 'en');
	const ru = translator(dictionaries.get(NS), 'ru');
	const zh = translator(dictionaries.get(NS), 'zh');
	const rows = (id) => ({ state: { byId: { s1: { projectionValues: { agentPreset: id } } } } });

	const ptc = renderChip(slot.component, { sessions: rows('ptc'), roster: createRoster(), t: en });
	assert.strictEqual(ptc.type, 'span');
	assert.deepStrictEqual(ptc.children, ['PTC']);
	assert.strictEqual(ptc.props['data-session-agent-mode'], 'ptc');

	const minimal = renderChip(slot.component, { sessions: rows('minimal'), roster: createRoster(), t: ru });
	assert.deepStrictEqual(minimal.children, ['Минимум']);

	const creator = renderChip(slot.component, { sessions: rows('cordis'), roster: createRoster(), t: zh });
	assert.deepStrictEqual(creator.children, ['创建']);
});

test('the chip stays compact: small type, capped width, single line', async () => {
	const { slot, dictionaries } = await boot();
	const chip = renderChip(slot.component, {
		sessions: { state: { byId: { s1: { projectionValues: { agentPreset: 'ptc' } } } } },
		roster: createRoster(),
		t: translator(dictionaries.get(NS), 'en'),
	});
	assert.strictEqual(chip.props.style.fontSize, 10);
	assert.strictEqual(chip.props.style.maxWidth, 84);
	assert.strictEqual(chip.props.style.whiteSpace, 'nowrap');
	assert.strictEqual(chip.props.style.display, 'inline-flex');
});

test('the Host roster is read once on start, not once per Session row', async () => {
	const { remote, slot, dictionaries } = await boot({
		rows: { s1: { projectionValues: { agentPreset: 'ptc' } }, s2: { projectionValues: { agentPreset: 'minimal' } } },
	});
	assert.strictEqual(remote.calls.length, 1);
	renderChip(slot.component, {
		sessions: { state: { byId: { s1: { projectionValues: { agentPreset: 'ptc' } } } } },
		roster: createRoster(),
		t: translator(dictionaries.get(NS), 'en'),
	});
	assert.strictEqual(remote.calls.length, 1, 'rendering asked for the roster again');
});

test('a custom preset renders the name the Host publishes for it', async () => {
	const { slot, dictionaries } = await boot({
		rows: { s1: { projectionValues: { agentPreset: 'my-mode' } } },
		responder: () => Promise.resolve(ok([{ id: 'my-mode', name: 'My Mode', description: 'Builds things' }])),
	});
	const roster = createRoster();
	roster.publish([{ id: 'my-mode', name: 'My Mode', description: 'Builds things' }]);
	const chip = renderChip(slot.component, {
		sessions: { state: { byId: { s1: { projectionValues: { agentPreset: 'my-mode' } } } } },
		roster,
		t: translator(dictionaries.get(NS), 'en'),
	});
	assert.deepStrictEqual(chip.children, ['My Mode']);
	assert.strictEqual(chip.props.title, 'My Mode - Builds things');
});

test('without a description the tooltip falls back to the hint sentence', async () => {
	const { slot, dictionaries } = await boot();
	const roster = createRoster();
	roster.publish([{ id: 'my-mode', name: 'My Mode' }]);
	const chip = renderChip(slot.component, {
		sessions: { state: { byId: { s1: { projectionValues: { agentPreset: 'my-mode' } } } } },
		roster,
		t: translator(dictionaries.get(NS), 'en'),
	});
	assert.strictEqual(chip.props.title, 'Agent preset this task runs: My Mode');
});

test('an unknown preset id asks the Host again on the next list change', async () => {
	const { remote, sessions } = await boot({
		rows: { s1: { projectionValues: { agentPreset: 'standard' } } },
	});
	assert.strictEqual(remote.calls.length, 1);
	sessions.set({ s1: { projectionValues: { agentPreset: 'weird-mode' } } });
	await flush();
	assert.strictEqual(remote.calls.length, 2, 'unknown preset did not trigger a second read');
	sessions.set({ s1: { projectionValues: { agentPreset: 'ptc' } } });
	await flush();
	assert.strictEqual(remote.calls.length, 2, 'a known built-in asked for the roster again');
});

test('a failed roster read leaves the plugin able to retry', async () => {
	const { remote, sessions } = await boot({
		rows: { s1: { projectionValues: { agentPreset: 'standard' } } },
		responder: (call) => Promise.resolve(call === 1 ? { ok: false, error: 'offline' } : ok([])),
	});
	assert.strictEqual(remote.calls.length, 1);
	sessions.set({ s1: { projectionValues: { agentPreset: 'weird-mode' } } });
	await flush();
	assert.strictEqual(remote.calls.length, 2, 'a failed read was not retried');
});

test('one read per newly seen unknown id, and none while the list stands still', async () => {
	const { remote, sessions } = await boot({
		rows: { s1: { projectionValues: { agentPreset: 'standard' } } },
		responder: () => Promise.resolve(ok([])),
	});
	assert.strictEqual(remote.calls.length, 1);
	sessions.set({ s1: { projectionValues: { agentPreset: 'first-mode' } } });
	await flush();
	assert.strictEqual(remote.calls.length, 2);
	// The roster answered with nothing, so the same id stays unknown - but a list
	// change that does not introduce a new id must not read the Host again.
	sessions.set({
		s1: { projectionValues: { agentPreset: 'first-mode' } },
		s2: { projectionValues: { agentPreset: 'ptc' } },
	});
	await flush();
	assert.strictEqual(remote.calls.length, 2, 'a standing unknown id kept re-reading');
	sessions.set({ s1: { projectionValues: { agentPreset: 'second-mode' } } });
	await flush();
	assert.strictEqual(remote.calls.length, 3, 'a new unknown id did not ask again');
});

test('a Host that throws instead of answering does not break the plugin', async () => {
	const { remote, slot, dictionaries } = await boot({
		responder: () => {
			throw new Error('no bridge');
		},
	});
	assert.strictEqual(remote.calls.length, 1);
	const chip = renderChip(slot.component, {
		sessions: { state: { byId: { s1: { projectionValues: { agentPreset: 'ptc' } } } } },
		roster: createRoster(),
		t: translator(dictionaries.get(NS), 'en'),
	});
	assert.deepStrictEqual(chip.children, ['PTC']);
});

test('the Session subscription is dropped with the plugin', async () => {
	const { sessions, effects } = await boot();
	const rosterEffect = effects.find((entry) => entry.label === 'session-agent-mode: roster load');
	assert.ok(rosterEffect, 'roster effect not registered');
	assert.strictEqual(sessions.listenerCount(), 1);
	rosterEffect.dispose();
	assert.strictEqual(sessions.listenerCount(), 0, 'subscription survived the dispose');
});

test('both effects are named so the Loader can report them', async () => {
	const { effects } = await boot();
	const labels = effects.map((entry) => entry.label);
	assert.deepStrictEqual(labels, [
		'session-agent-mode: dictionaries',
		'session-agent-mode: roster load',
	]);
});

// ------------------------------------------------------------------ runner

(async () => {
	let failed = 0;
	for (const { name, fn } of tests) {
		try {
			await fn();
			console.log(`  ok   ${name}`);
		} catch (error) {
			failed += 1;
			console.log(`  FAIL ${name}`);
			console.log(String(error && error.stack ? error.stack : error).replace(/^/gm, '       '));
		}
	}
	console.log(`\n${tests.length - failed}/${tests.length} scenarios passed`);
	process.exitCode = failed === 0 ? 0 : 1;
})();
