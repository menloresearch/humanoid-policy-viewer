// Plugins
import Components from 'unplugin-vue-components/vite'
import Vue from '@vitejs/plugin-vue'
import Vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'
import Fonts from 'unplugin-fonts/vite'

// Utilities
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { viewerServer } from './scripts/viewerServer.mjs'
import { getBenchmarkResultsDir, getBenchmarkTemplate, getLogDir, getPolicyLibrary } from './scripts/policyLibraryConfig.mjs'
import { defaultBenchmarkDir } from './scripts/benchmarkDir.mjs'

const appDir = fileURLToPath(new URL('.', import.meta.url))

// A submodule checked out under public/ carries a `.git` pointer file that
// must not be deployed along with the scene assets.
function dropGitPointerFiles() {
  let scenesDir;
  return {
    name: 'drop-git-pointer-files',
    apply: 'build',
    configResolved(config) {
      scenesDir = resolve(config.root, config.build.outDir, 'examples/scenes');
    },
    closeBundle() {
      if (!existsSync(scenesDir)) return;
      for (const entry of readdirSync(scenesDir, { withFileTypes: true })) {
        const pointer = resolve(scenesDir, entry.name, '.git');
        if (entry.isDirectory() && existsSync(pointer) && statSync(pointer).isFile()) unlinkSync(pointer);
      }
    },
  };
}

/**
 * The server options for a plain `npx vite` / `vite build`, from the HPV_*
 * variables (see scripts/policyLibraryConfig.mjs). The launchers pass their own
 * to viteConfig instead (scripts/startViewer.mjs).
 */
export function serverOptionsFromEnv(env = process.env) {
  const { baseDir, roots } = getPolicyLibrary(env)
  return {
    benchmarksDir: resolve(env.HPV_BENCHMARKS_DIR || resolve(appDir, 'benchmarks')),
    openBenchmark: defaultBenchmarkDir(appDir),
    resultsDir: getBenchmarkResultsDir(appDir, env),
    benchmarkTemplate: getBenchmarkTemplate(appDir, env),
    logDir: getLogDir(appDir, env),
    policyLibraryDir: baseDir,
    policyRoots: roots,
  }
}

// https://vitejs.dev/config/
export function viteConfig(serverOptions) {
  return {
    base: '/',
    plugins: [
      Vue({
        template: { transformAssetUrls },
      }),
      // https://github.com/vuetifyjs/vuetify-loader/tree/master/packages/vite-plugin#readme
      Vuetify({
        styles: {
          configFile: './src/styles/settings.scss',
        },
      }),
      Components(),
      viewerServer(serverOptions),
      dropGitPointerFiles(),
      Fonts({
        fontsource: {
          families: [
            {
              name: 'Roboto',
              weights: [100, 300, 400, 500, 700, 900],
              styles: ['normal', 'italic'],
            },
          ],
        },
      }),
    ],
    optimizeDeps: {
      exclude: ['vuetify', 'onnxruntime-web'],
    },
    define: { 'process.env': {} },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
      extensions: [
        '.js',
        '.json',
        '.jsx',
        '.mjs',
        '.ts',
        '.tsx',
        '.vue',
      ],
    },
    server: {
      host: '127.0.0.1',
      port: 3000,
      watch: {
        // Saving trajectory/benchmark JSON must not trigger a full page reload.
        // Anchored to the app folder: a bare **/benchmark/** would also stop
        // edits to src/benchmark/ from hot-reloading.
        ignored: ['benchmarks', 'benchmark_results', 'logs']
          .map((folder) => fileURLToPath(new URL(`./${folder}/**`, import.meta.url))),
      },
    },
    css: {
      preprocessorOptions: {
        sass: {
          api: 'modern-compiler',
        },
        scss: {
          api:'modern-compiler',
        },
      },
    },
  }
}

export default defineConfig(() => viteConfig(serverOptionsFromEnv()))
