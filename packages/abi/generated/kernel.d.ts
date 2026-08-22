// world root:component/root
import type * as WasmosAbiHomeStore from './interfaces/wasmos-abi-home-store.js'; // wasmos:abi/home-store@0.1.0
import type * as WasmosAbiMntStore from './interfaces/wasmos-abi-mnt-store.js'; // wasmos:abi/mnt-store@0.1.0
import type * as WasmosAbiSysStore from './interfaces/wasmos-abi-sys-store.js'; // wasmos:abi/sys-store@0.1.0
import type * as WasmosAbiControl from './interfaces/wasmos-abi-control.js'; // wasmos:abi/control@0.1.0
export interface ImportObject {
  'wasmos:abi/home-store@0.1.0': typeof WasmosAbiHomeStore,
  'wasmos:abi/mnt-store@0.1.0': typeof WasmosAbiMntStore,
  'wasmos:abi/sys-store@0.1.0': typeof WasmosAbiSysStore,
}
export interface Root {
  'wasmos:abi/control@0.1.0': typeof WasmosAbiControl,
  control: typeof WasmosAbiControl,
}

/**
* Instantiates this component with the provided imports and
* returns a map of all the exports of the component.
*
* This function is intended to be similar to the
* `WebAssembly.Instantiate` constructor. The second `imports`
* argument is the "import object" for wasm, except here it
* uses component-model-layer types instead of core wasm
* integers/numbers/etc.
*
* The first argument to this function, `getCoreModule`, is
* used to compile core wasm modules within the component.
* Components are composed of core wasm modules and this callback
* will be invoked per core wasm module. The caller of this
* function is responsible for reading the core wasm module
* identified by `path` and returning its compiled
* `WebAssembly.Module` object. This would use the
* `WebAssembly.Module` constructor on the web, for example.
*/
export function instantiate(
getCoreModule: (path: string) => WebAssembly.Module,
imports: ImportObject,
instantiateCore?: (module: WebAssembly.Module, imports: Record<string, any>) => WebAssembly.Instance
): Root;
export function instantiate(
getCoreModule: (path: string) => WebAssembly.Module | Promise<WebAssembly.Module>,
imports: ImportObject,
instantiateCore?: (module: WebAssembly.Module, imports: Record<string, any>) => WebAssembly.Instance | Promise<WebAssembly.Instance>
): Root | Promise<Root>;

