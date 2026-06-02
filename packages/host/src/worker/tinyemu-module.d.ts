// Ambient types for the vendored TinyEMU ESM module factory
// (third_party/tinyemu/riscvemu64-wasm.js, MIT — built from source). Declares just
// the surface the emulator worker uses so `tsc --noEmit` type-checks the import.
declare module "*/riscvemu64-wasm.js" {
  interface TinyEmuModule {
    /** emscripten ccall: invoke an exported C function (e.g. vm_start, console_queue_char). */
    ccall(name: string, ret: string | null, argTypes: string[], args: unknown[]): unknown;
    HEAPU8: Uint8Array;
  }
  interface TinyEmuModuleArg {
    locateFile?: (path: string) => string;
    printErr?: (s: string) => void;
    print?: (s: string) => void;
  }
  /** The MODULARIZE/EXPORT_ES6 factory; resolves to the Module once the runtime is up. */
  export default function createTinyEmu(moduleArg?: TinyEmuModuleArg): Promise<TinyEmuModule>;
}
