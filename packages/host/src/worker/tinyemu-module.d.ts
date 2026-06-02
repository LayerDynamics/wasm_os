// Ambient types for the vendored TinyEMU ESM module factory
// (third_party/tinyemu/riscvemu64-wasm.js, MIT — built from source). Declares just
// the surface the emulator worker uses so `tsc --noEmit` type-checks the import.
declare module "*/riscvemu64-wasm.js" {
  /** The emscripten in-memory filesystem (MEMFS) backing the FR-29 9p share. */
  interface TinyEmuFS {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    stat(path: string): { size: number; mtime: Date; mode: number };
  }
  interface TinyEmuModule {
    /** emscripten ccall: invoke an exported C function (e.g. vm_start, console_queue_char). */
    ccall(name: string, ret: string | null, argTypes: string[], args: unknown[]): unknown;
    HEAPU8: Uint8Array;
    FS: TinyEmuFS;
  }
  interface TinyEmuModuleArg {
    locateFile?: (path: string) => string;
    printErr?: (s: string) => void;
    print?: (s: string) => void;
  }
  /** The MODULARIZE/EXPORT_ES6 factory; resolves to the Module once the runtime is up. */
  export default function createTinyEmu(moduleArg?: TinyEmuModuleArg): Promise<TinyEmuModule>;
}
