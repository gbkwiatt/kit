import fs from 'fs';
import path from 'path';
import colors from 'kleur';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { searchForWorkspaceRoot } from 'vite';
import { mkdirp, posixify, rimraf } from '../utils/filesystem.js';
import * as sync from '../core/sync/sync.js';
import { build_server } from './build/build_server.js';
import { build_service_worker } from './build/build_service_worker.js';
import { prerender } from '../core/prerender/prerender.js';
import { load_config } from '../core/config/index.js';
import { dev } from './dev/index.js';
import { generate_manifest } from '../core/generate_manifest/index.js';
import { get_runtime_path, logger } from '../core/utils.js';
import { find_deps, get_default_config } from './build/utils.js';
import { preview } from './preview/index.js';
import { get_aliases, resolve_entry } from './utils.js';

const cwd = process.cwd();

/** @type {Record<string, any>} */
const enforced_config = {
	base: true,
	build: {
		cssCodeSplit: true,
		emptyOutDir: true,
		lib: {
			entry: true,
			name: true,
			formats: true
		},
		manifest: true,
		outDir: true,
		polyfillDynamicImport: true,
		rollupOptions: {
			input: true,
			output: {
				format: true,
				entryFileNames: true,
				chunkFileNames: true,
				assetFileNames: true
			},
			preserveEntrySignatures: true
		},
		ssr: true
	},
	publicDir: true,
	resolve: {
		alias: {
			$app: true,
			$lib: true,
			'$service-worker': true
		}
	},
	root: true
};

/**
 * @return {import('vite').Plugin[]}
 */
export function sveltekit() {
	return [...svelte(), kit()];
}

/**
 * @return {import('vite').Plugin}
 */
function kit() {
	/** @type {import('types').ValidatedConfig} */
	let svelte_config;

	/** @type {import('vite').ResolvedConfig} */
	let vite_config;

	/** @type {import('vite').ConfigEnv} */
	let vite_config_env;

	/** @type {import('types').ManifestData} */
	let manifest_data;

	/** @type {boolean} */
	let is_build;

	/** @type {import('types').Logger} */
	let log;

	/** @type {import('types').Prerendered} */
	let prerendered;

	/** @type {import('types').BuildData} */
	let build_data;

	/**
	 * @type {{
	 *   build_dir: string;
	 *   output_dir: string;
	 *   client_out_dir: string;
	 * }}
	 */
	let paths;

	function create_client_config() {
		/** @type {Record<string, string>} */
		const input = {
			// Put unchanging assets in immutable directory. We don't set that in the
			// outDir so that other plugins can add mutable assets to the bundle
			start: `${get_runtime_path(svelte_config.kit)}/client/start.js`
		};

		// This step is optional — Vite/Rollup will create the necessary chunks
		// for everything regardless — but it means that entry chunks reflect
		// their location in the source code, which is helpful for debugging
		manifest_data.components.forEach((file) => {
			const resolved = path.resolve(cwd, file);
			const relative = decodeURIComponent(path.relative(svelte_config.kit.files.routes, resolved));

			const name = relative.startsWith('..')
				? path.basename(file)
				: posixify(path.join('pages', relative));
			input[name] = resolved;
		});

		return get_default_config({
			config: svelte_config,
			input,
			ssr: false,
			outDir: `${paths.client_out_dir}`
		});
	}

	return {
		name: 'vite-plugin-svelte-kit',

		async config(config, config_env) {
			vite_config_env = config_env;
			svelte_config = await load_config();
			is_build = config_env.command === 'build';

			paths = {
				build_dir: `${svelte_config.kit.outDir}/build`,
				output_dir: `${svelte_config.kit.outDir}/output`,
				client_out_dir: `${svelte_config.kit.outDir}/output/client/${svelte_config.kit.appDir}`
			};

			if (is_build) {
				process.env.VITE_SVELTEKIT_APP_VERSION = svelte_config.kit.version.name;
				process.env.VITE_SVELTEKIT_APP_VERSION_FILE = `${svelte_config.kit.appDir}/version.json`;
				process.env.VITE_SVELTEKIT_APP_VERSION_POLL_INTERVAL = `${svelte_config.kit.version.pollInterval}`;

				manifest_data = sync.all(svelte_config).manifest_data;

				const new_config = create_client_config();

				warn_overridden_config(config, new_config);

				return new_config;
			}

			// dev and preview config can be shared
			const result = {
				base: '/',
				build: {
					rollupOptions: {
						// Vite dependency crawler needs an explicit JS entry point
						// eventhough server otherwise works without it
						input: `${get_runtime_path(svelte_config.kit)}/client/start.js`
					}
				},
				resolve: {
					alias: get_aliases(svelte_config.kit)
				},
				root: cwd,
				server: {
					fs: {
						allow: [
							...new Set([
								svelte_config.kit.files.lib,
								svelte_config.kit.files.routes,
								svelte_config.kit.outDir,
								path.resolve(cwd, 'src'),
								path.resolve(cwd, 'node_modules'),
								path.resolve(searchForWorkspaceRoot(cwd), 'node_modules')
							])
						]
					},
					watch: {
						ignored: [
							// Ignore all siblings of config.kit.outDir/generated
							`${posixify(svelte_config.kit.outDir)}/!(generated)`
						]
					}
				}
			};
			warn_overridden_config(config, result);
			return result;
		},

		configResolved(config) {
			vite_config = config;
		},

		buildStart() {
			if (is_build) {
				rimraf(paths.build_dir);
				mkdirp(paths.build_dir);

				rimraf(paths.output_dir);
				mkdirp(paths.output_dir);
			}
		},

		async writeBundle(_options, bundle) {
			log = logger({
				verbose: vite_config.logLevel === 'info'
			});

			fs.writeFileSync(
				`${paths.client_out_dir}/version.json`,
				JSON.stringify({ version: process.env.VITE_SVELTEKIT_APP_VERSION })
			);

			/** @type {import('rollup').OutputChunk[]} */
			const chunks = [];
			/** @type {import('rollup').OutputAsset[]} */
			const assets = [];
			for (const key of Object.keys(bundle)) {
				// collect asset and output chunks
				if (bundle[key].type === 'asset') {
					assets.push(/** @type {import('rollup').OutputAsset} */ (bundle[key]));
				} else {
					chunks.push(/** @type {import('rollup').OutputChunk} */ (bundle[key]));
				}
			}

			/** @type {import('vite').Manifest} */
			const vite_manifest = JSON.parse(
				fs.readFileSync(`${paths.client_out_dir}/manifest.json`, 'utf-8')
			);

			const entry_id = posixify(
				path.relative(cwd, `${get_runtime_path(svelte_config.kit)}/client/start.js`)
			);

			const client = {
				assets,
				chunks,
				entry: find_deps(vite_manifest, entry_id, false),
				vite_manifest
			};
			log.info(`Client build completed. Wrote ${chunks.length} chunks and ${assets.length} assets`);

			const options = {
				cwd,
				config: svelte_config,
				vite_config_env,
				build_dir: paths.build_dir, // TODO just pass `paths`
				manifest_data,
				output_dir: paths.output_dir,
				service_worker_entry_file: resolve_entry(svelte_config.kit.files.serviceWorker)
			};

			log.info('Building server');

			const server = await build_server(options, client);

			process.env.SVELTEKIT_SERVER_BUILD_COMPLETED = 'true';

			/** @type {import('types').BuildData} */
			build_data = {
				app_dir: svelte_config.kit.appDir,
				manifest_data,
				service_worker: options.service_worker_entry_file ? 'service-worker.js' : null, // TODO make file configurable?
				client,
				server
			};

			fs.writeFileSync(
				`${paths.output_dir}/server/manifest.js`,
				`export const manifest = ${generate_manifest({
					build_data,
					relative_path: '.',
					routes: manifest_data.routes
				})};\n`
			);

			const static_files = manifest_data.assets.map((asset) => posixify(asset.file));

			const files = new Set([
				...static_files,
				...chunks.map((chunk) => `${svelte_config.kit.appDir}/${chunk.fileName}`),
				...assets.map((chunk) => `${svelte_config.kit.appDir}/${chunk.fileName}`)
			]);

			// TODO is this right?
			static_files.forEach((file) => {
				if (file.endsWith('/index.html')) {
					files.add(file.slice(0, -11));
				}
			});

			log.info('Prerendering');

			prerendered = await prerender({
				config: svelte_config.kit,
				entries: manifest_data.routes
					.map((route) => (route.type === 'page' ? route.path : ''))
					.filter(Boolean),
				files,
				log
			});

			if (options.service_worker_entry_file) {
				if (svelte_config.kit.paths.assets) {
					throw new Error('Cannot use service worker alongside config.kit.paths.assets');
				}

				log.info('Building service worker');

				await build_service_worker(options, prerendered, client.vite_manifest);
			}

			console.log(
				`\nRun ${colors.bold().cyan('npm run preview')} to preview your production build locally.`
			);
		},

		async closeBundle() {
			if (!is_build) {
				return; // vite calls closeBundle when dev-server restarts, ignore that
			}
			if (svelte_config.kit.adapter) {
				const { adapt } = await import('../core/adapt/index.js');
				await adapt(svelte_config, build_data, prerendered, { log });
			} else {
				console.log(colors.bold().yellow('\nNo adapter specified'));
				// prettier-ignore
				console.log(
					`See ${colors.bold().cyan('https://kit.svelte.dev/docs/adapters')} to learn how to configure your app to run on the platform of your choosing`
				);
			}

			if (svelte_config.kit.prerender.enabled) {
				// this is necessary to close any open db connections, etc.
				// TODO: prerender in a subprocess so we can exit in isolation
				// https://github.com/sveltejs/kit/issues/5306
				process.exit(0);
			}
		},

		async configureServer(vite) {
			return await dev(vite, vite_config, svelte_config);
		},

		configurePreviewServer(vite) {
			return preview(vite, svelte_config, vite_config.preview.https ? 'https' : 'http');
		}
	};
}

/**
 * @param {Record<string, any>} config
 * @param {Record<string, any>} resolved_config
 * @param {string} [path]
 * @param {string[]} [out] used locally to compute the return value
 */
function warn_overridden_config(config, resolved_config, path = '', out = []) {
	const overridden = find_overridden_config(config, resolved_config, path, out);
	if (overridden.length > 0) {
		console.log(
			colors.bold().red('The following Vite config options will be overridden by SvelteKit:')
		);
		console.log(overridden.map((key) => `  - ${key}`).join('\n'));
	}
}

/**
 * @param {Record<string, any>} config
 * @param {Record<string, any>} resolved_config
 * @param {string} path
 * @param {string[]} out used locally to compute the return value
 */
function find_overridden_config(config, resolved_config, path, out) {
	for (const key in enforced_config) {
		if (typeof config === 'object' && config !== null && key in config) {
			if (enforced_config[key] === true && config[key] !== resolved_config[key]) {
				out.push(path + key);
			} else {
				find_overridden_config(config[key], resolved_config[key], path + key + '.', out);
			}
		}
	}

	return out;
}
