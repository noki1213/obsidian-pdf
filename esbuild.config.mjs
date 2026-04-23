import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2020",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins
	]
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
