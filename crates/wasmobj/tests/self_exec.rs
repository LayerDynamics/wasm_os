//! Proves FR-9: a filled object, run as a wasip1 module, writes its content to stdout.
use wasmobj::{mint, save, Tier};
use wasmtime::*;
use wasmtime_wasi::pipe::MemoryOutputPipe;
use wasmtime_wasi::preview1::{self, WasiP1Ctx};
use wasmtime_wasi::WasiCtxBuilder;

#[test]
fn filled_object_renders_its_content_to_stdout() {
    let mut obj = mint(Tier::K4, 0);
    save(&mut obj, b"the document renders itself").unwrap();

    let engine = Engine::default();
    let module = Module::new(&engine, &obj).expect("module loads");

    let stdout = MemoryOutputPipe::new(4096);
    let wasi: WasiP1Ctx = WasiCtxBuilder::new().stdout(stdout.clone()).build_p1();
    let mut store = Store::new(&engine, wasi);
    let mut linker: Linker<WasiP1Ctx> = Linker::new(&engine);
    preview1::add_to_linker_sync(&mut linker, |c| c).unwrap();

    let inst = linker.instantiate(&mut store, &module).unwrap();
    let start = inst.get_typed_func::<(), ()>(&mut store, "_start").unwrap();
    start.call(&mut store, ()).unwrap();
    drop(store);

    let out = stdout.contents();
    assert_eq!(&out[..], b"the document renders itself");
}
